import type { Category, Level, PolicyContext } from "./policy";
import { categoryFor, decide } from "./policy";
import type { AgentAdapter, ToolResult } from "./adapters";
import type { ToolDefinition, ToolEnv, ToolOutcome } from "./tools";
import { userTimeZone } from "./liveTools";
import { gbCloseTab } from "../../lib/ipc";

/**
 * Helpers: when a task has separate parts, the main AI (on the chat's own model) hands up to three
 * of them to helpers that work at the same time on Gemini 3.5 Flash-Lite, then combines what they
 * found. Helpers only look things up — searching, reading pages (each in its own E.V Browser
 * tab) and files, live facts — so they never need an approval, never edit and never act on the Mac.
 * Everything else stays with the main AI.
 */

export const HELPER_MODEL = "gemini-3.5-flash-lite";
export const MAX_HELPERS = 3;
export const HELPER_MAX_STEPS = 6;
/** Don't split when fewer Flash-Lite requests than this are left today across all keys. */
export const MIN_REQUESTS_LEFT = 60;
export const SPLIT_TOOL = "split_into_helpers";

/** Tools a helper may use: looking things up only. */
export const HELPER_TOOLS = new Set([
  "web_search",
  "web_fetch",
  "browser_go",
  "browser_look",
  "get_weather",
  "sports",
  "wikipedia",
  "convert_time",
  "calculate",
  "convert_units",
  "read_file",
  "list_directory",
  "find_files",
  "search_files",
]);

// ── The free filter: no AI involved ───────────────────────────────────────────

const MULTI_PART = /\b(compare|comparison|versus|vs\.?|each of|all of|both|research|find out|look up|investigate|analy[sz]e|review|summari[sz]e|pros and cons|differences?|options|alternatives|which (?:one|is better)|best\b)/i;
const LIST = /(?:,\s*[^,]{2,}){2,}|\b\w[\w\s.-]{1,40}\band\b\s+\w[\w\s.-]{1,40}\band\b|^\s*(?:[-*•]|\d+[.)])\s/m;

/**
 * Whether a message could be worth splitting. Short or simple requests (greetings, one question,
 * quick commands) never are; a split also needs several named things or parts to work on.
 */
export function mightSplit(text: string): boolean {
  const t = text.trim();
  if (t.length < 40) return false;
  const words = t.split(/\s+/).length;
  if (words < 8) return false;
  const parts = LIST.test(t) || /\b(?:and then|also|as well as|plus)\b/i.test(t);
  return (MULTI_PART.test(t) && parts) || (parts && words >= 25);
}

// ── The split tool the main AI sees ───────────────────────────────────────────

export const SPLIT_TOOL_DEFINITION: ToolDefinition = {
  name: SPLIT_TOOL,
  description: [
    `Hand separate parts of this task to up to ${MAX_HELPERS} helpers that work at the same time (fast model, look-up only: web search, web pages, live facts, reading files). You get back each helper's report, then you write the answer.`,
    "Use it ONLY when the task has 2–3 parts that don't depend on each other and each needs real look-up work (several searches, pages or files) — e.g. comparing three products, researching three topics, checking several files.",
    "Don't use it for one question, quick facts, chat, anything one or two tool calls can answer, steps that depend on each other, or anything that changes files, sends, clicks or controls the Mac. When in doubt, don't split.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      parts: {
        type: "array",
        description: `2 to ${MAX_HELPERS} independent parts`,
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short name, e.g. 'MacBook Air M5'" },
            task: { type: "string", description: "Exactly what this helper should find out, with every detail it needs (it can't see the conversation)" },
          },
          required: ["title", "task"],
        },
      },
    },
    required: ["parts"],
  },
};

export interface HelperPart {
  title: string;
  task: string;
}

export function parseParts(args: Record<string, unknown>): HelperPart[] {
  const raw = Array.isArray(args.parts) ? args.parts : [];
  return raw
    .map((p) => {
      const part = (p ?? {}) as Record<string, unknown>;
      return { title: String(part.title ?? "").trim().slice(0, 60), task: String(part.task ?? "").trim() };
    })
    .filter((p) => p.title && p.task)
    .slice(0, MAX_HELPERS);
}

/** Whether the keys have room for helpers today. Unknown limits count as room. */
export function haveRoom(remaining: number | null, usable: number): boolean {
  return usable > 0 && (remaining === null || remaining >= MIN_REQUESTS_LEFT);
}

// ── Running helpers ───────────────────────────────────────────────────────────

export type HelperStatus = "working" | "done" | "failed";

export interface HelperUpdate {
  status: HelperStatus;
  /** What it's doing now, or a short summary when done. */
  note: string;
}

export interface HelperDeps {
  adapter: AgentAdapter;
  /** Runs one model request on a key from the pool; `lane` keeps helpers on different keys. */
  runModel: <T>(lane: string, run: (key: string) => Promise<{ value: T; headers: Record<string, string> }>) => Promise<T>;
  execute: (name: string, args: Record<string, unknown>, env: ToolEnv) => Promise<ToolOutcome>;
  describe: (name: string, args: Record<string, unknown>) => string;
  tools: ToolDefinition[];
  env: ToolEnv;
  policy: { ctx: PolicyContext; levels: Record<Category, Level> };
  signal: AbortSignal;
  onUpdate: (index: number, update: HelperUpdate) => void;
}

function helperSystem(part: HelperPart, letter: string): string {
  const now = new Date();
  return [
    `You are helper ${letter} inside E.V, working for its main AI on one part of a bigger task: "${part.title}".`,
    "Do only your part. Use your tools to get real, current facts — you can search, open pages, check live data and read files, nothing else. web_fetch is quickest for articles; use browser_go for pages that need a real browser (YouTube, GitHub, sites that build themselves with scripts, search pages).",
    "Go to the source first and trust it: for a YouTube channel open https://www.youtube.com/@<handle>/videos (if that's wrong, https://www.youtube.com/results?search_query=<name>); the first video under Latest is the newest. Every fact about one video or repo must come from that same item. Never report something as unavailable before opening its source page.",
    "When you have enough, reply with a short factual report for the main AI: key findings as bullets, with numbers, dates and the URLs you used. No greetings, no questions, no advice on other parts.",
    "If something can't be found, say so plainly — never guess.",
    `Now: ${now.toLocaleString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} (${userTimeZone()}).`,
  ].join("\n");
}

async function runHelper(part: HelperPart, index: number, deps: HelperDeps): Promise<string> {
  const letter = String.fromCharCode(65 + index);
  const lane = `helper-${letter}`;
  const env: ToolEnv = { ...deps.env, searches: 0, mac: undefined, browserTab: lane };
  const system = helperSystem(part, letter);
  const tools = deps.tools.filter((t) => HELPER_TOOLS.has(t.name));
  const conversation: unknown[] =
    deps.adapter.provider === "gemini" ? [{ role: "user", parts: [{ text: part.task }] }] : [{ role: "user", content: part.task }];
  let answer = "";
  deps.onUpdate(index, { status: "working", note: "Starting…" });

  for (let step = 0; step < HELPER_MAX_STEPS; step++) {
    if (deps.signal.aborted) throw new Error("stopped");
    let text = "";
    const out = await deps.runModel(lane, async (key) => {
      text = "";
      const result = await deps.adapter.step({
        model: HELPER_MODEL,
        key,
        system,
        conversation,
        tools,
        signal: deps.signal,
        onText: (delta) => void (text += delta),
      });
      return { value: result, headers: result.headers };
    });
    conversation.push(out.item);
    answer = text.trim() || answer;
    if (out.calls.length === 0) break;

    const results: ToolResult[] = [];
    for (const call of out.calls) {
      const category = categoryFor(call.name, call.args, deps.policy.ctx);
      const allowed = HELPER_TOOLS.has(call.name) && decide(category, deps.policy.levels, null, call.name, call.args, deps.policy.ctx) === "run";
      if (!allowed) {
        results.push({ call, output: "Helpers can only look things up without approval. Leave this to the main AI and report what you found." });
        continue;
      }
      deps.onUpdate(index, { status: "working", note: deps.describe(call.name, call.args) });
      const outcome = await deps.execute(call.name, call.args, env);
      results.push({ call, output: outcome.output });
    }
    conversation.push(...deps.adapter.toolResults(results));
    if (step === HELPER_MAX_STEPS - 2) {
      // One step left: make the next reply the report.
      conversation.push(
        deps.adapter.provider === "gemini"
          ? { role: "user", parts: [{ text: "Write your report now from what you have." }] }
          : { role: "user", content: "Write your report now from what you have." },
      );
    }
  }
  return answer || "No report (ran out of steps without finding enough).";
}

/** Runs every part at the same time; returns the reports for the main AI. Failures don't stop the others. */
export async function runHelpers(parts: HelperPart[], deps: HelperDeps): Promise<{ output: string; display: string; ok: boolean }> {
  const started = Date.now();
  const settled = await Promise.allSettled(parts.map((part, i) => runHelper(part, i, deps)));
  // Each helper's browser tab is closed when it's done (nothing happens if it never opened one).
  await Promise.all(parts.map((_, i) => gbCloseTab(`helper-${String.fromCharCode(65 + i)}`).catch(() => {})));
  const reports = settled.map((r, i) => {
    const letter = String.fromCharCode(65 + i);
    if (r.status === "fulfilled") {
      const first = r.value
        .split("\n")
        .map((l) => l.replace(/[*_`#>]+/g, "").replace(/^[-•\s\d.)]+/, "").trim())
        .find((l) => l.length > 3);
      deps.onUpdate(i, { status: "done", note: first?.slice(0, 120) ?? "Done" });
      return `## Helper ${letter} — ${parts[i].title}\n${r.value}`;
    }
    deps.onUpdate(i, { status: "failed", note: String(r.reason).slice(0, 120) });
    return `## Helper ${letter} — ${parts[i].title}\n(Failed: ${String(r.reason).slice(0, 200)} — cover this part yourself if it matters.)`;
  });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const ok = settled.some((r) => r.status === "fulfilled");
  return {
    output: `${reports.join("\n\n")}\n\nCombine these into one answer for the user. Check they agree; where they conflict or look doubtful, say so or verify with one more look-up.`,
    display: `${parts.length} helpers finished in ${seconds}s`,
    ok,
  };
}
