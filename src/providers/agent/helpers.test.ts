import { describe, expect, it } from "vitest";
import type { AgentAdapter, ToolResult } from "./adapters";
import { haveRoom, HELPER_MAX_STEPS, HELPER_MODEL, mightSplit, parseParts, runHelpers, type HelperDeps } from "./helpers";
import { DEFAULT_RULES } from "./policy";
import type { ToolDefinition, ToolEnv } from "./tools";

describe("the free filter: which messages could split", () => {
  it("never splits simple requests", () => {
    for (const text of [
      "hello",
      "what's the weather in Springfield",
      "pause the music",
      "open Discord and tell Chris I'll be late",
      "what's 17.5% of 2480",
      "remind me to call mom at six tomorrow",
      "summarise this article for me please",
      "fix the bug in the login page where the button doesn't work",
    ]) {
      expect(mightSplit(text), text).toBe(false);
    }
  });

  it("offers splitting for tasks with separate parts", () => {
    for (const text of [
      "Compare the MacBook Air M5, the Dell XPS 14 and the ThinkPad X1 Carbon for battery life, weight and price",
      "Research the best budget phones from Samsung, Google and Motorola and tell me which one to buy",
      "Find out the opening hours, ticket prices and parking options for the Exploratorium, the California Academy of Sciences and the Tech Museum",
    ]) {
      expect(mightSplit(text), text).toBe(true);
    }
  });

  it("keeps at most three parts and drops empty ones", () => {
    const parts = parseParts({ parts: [{ title: "A", task: "a" }, { title: "", task: "x" }, { title: "B", task: "b" }, { title: "C", task: "c" }, { title: "D", task: "d" }] });
    expect(parts.map((p) => p.title)).toEqual(["A", "B", "C"]);
  });

  it("doesn't split when the keys are low today", () => {
    expect(haveRoom(10, 16)).toBe(false);
    expect(haveRoom(5000, 16)).toBe(true);
    expect(haveRoom(null, 3)).toBe(true);
    expect(haveRoom(5000, 0)).toBe(false);
  });
});

type Script = (step: number, task: string) => { calls: { name: string; args: Record<string, unknown> }[]; text?: string };

function fakeDeps(script: Script, opts: { delayMs?: number; failFor?: string } = {}) {
  const models: string[] = [];
  const executed: string[] = [];
  const lanes = new Set<string>();
  let active = 0;
  let peak = 0;
  const adapter: AgentAdapter = {
    provider: "gemini",
    async step({ model, conversation, onText }) {
      models.push(model);
      const first = conversation[0] as { parts: { text: string }[] };
      const task = first.parts[0].text;
      if (opts.failFor && task.includes(opts.failFor)) throw new Error("quota exceeded");
      const step = conversation.filter((c) => (c as { role: string }).role === "model").length;
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 20));
      active--;
      const out = script(step, task);
      if (out.text) onText(out.text);
      return {
        calls: out.calls.map((c, i) => ({ id: `${step}-${i}`, ...c })),
        item: { role: "model", parts: [{ text: out.text ?? "" }] },
        text: out.text ?? "",
        headers: {},
      };
    },
    toolResults: (results: ToolResult[]) => results.map((r) => ({ role: "user", parts: [{ text: r.output }] })),
  };
  const deps: HelperDeps = {
    adapter,
    runModel: async (lane, run) => {
      lanes.add(lane);
      return (await run("key")).value;
    },
    execute: async (name) => {
      executed.push(name);
      return { output: `result of ${name}`, display: name, ok: true };
    },
    describe: (name) => name,
    tools: ["web_search", "web_fetch", "write_file", "mac_click"].map((name) => ({ name, description: "", parameters: { type: "object", properties: {} } }) as ToolDefinition),
    env: { cwd: "/p", home: "/Users/u", signal: new AbortController().signal, webSearch: async () => "" } as ToolEnv,
    policy: { ctx: { cwd: "/p", home: "/Users/u", hasProject: true, readLocal: false, taskApps: new Set(), neverApps: [] }, levels: DEFAULT_RULES.levels },
    signal: new AbortController().signal,
    onUpdate: () => {},
  };
  return { deps, models, executed, lanes, peak: () => peak };
}

const parts = [
  { title: "MacBook Air", task: "Battery life of the MacBook Air M5" },
  { title: "Dell XPS", task: "Battery life of the Dell XPS 14" },
  { title: "ThinkPad", task: "Battery life of the ThinkPad X1" },
];

describe("helpers", () => {
  it("work at the same time on Flash-Lite, each on its own key lane", async () => {
    const run = fakeDeps((step, task) => (step === 0 ? { calls: [{ name: "web_search", args: { query: task } }] } : { calls: [], text: `- ${task}: 15 hours` }), { delayMs: 60 });
    const started = Date.now();
    const out = await runHelpers(parts, run.deps);
    const elapsed = Date.now() - started;
    expect(run.peak()).toBe(3);
    expect(elapsed).toBeLessThan(60 * 2 * 3); // well under doing the three one after another
    expect(new Set(run.models)).toEqual(new Set([HELPER_MODEL]));
    expect(run.lanes).toEqual(new Set(["helper-A", "helper-B", "helper-C"]));
    expect(out.ok).toBe(true);
    expect(out.output).toContain("Helper A — MacBook Air");
    expect(out.output).toContain("Battery life of the ThinkPad X1: 15 hours");
  });

  it("can only look things up: edits and Mac control are refused", async () => {
    const run = fakeDeps((step) =>
      step === 0 ? { calls: [{ name: "write_file", args: { path: "x.txt", content: "y" } }, { name: "mac_click", args: { app: "Discord", id: 3 } }, { name: "web_fetch", args: { url: "https://example.com" } }] } : { calls: [], text: "done" },
    );
    await runHelpers(parts.slice(0, 2), run.deps);
    expect(run.executed).toEqual(["web_fetch", "web_fetch"]);
  });

  it("stops each helper after its step limit", async () => {
    const run = fakeDeps(() => ({ calls: [{ name: "web_search", args: { query: "again" } }], text: "partial" }));
    const out = await runHelpers(parts.slice(0, 2), run.deps);
    expect(run.models.length).toBe(2 * HELPER_MAX_STEPS);
    expect(out.ok).toBe(true);
  });

  it("one failing helper doesn't stop the others", async () => {
    const run = fakeDeps((step, task) => (step === 0 ? { calls: [], text: `found ${task}` } : { calls: [] }), { failFor: "Dell" });
    const out = await runHelpers(parts, run.deps);
    expect(out.ok).toBe(true);
    expect(out.output).toContain("found Battery life of the MacBook Air M5");
    expect(out.output).toMatch(/Helper B — Dell XPS\n\(Failed/);
  });
});
