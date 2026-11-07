import { routePrewarm, routeRequest } from "../lib/ipc";
import { useSettings } from "../store/settings";
import { useVault } from "../store/vault";
import { findFile } from "./filePicker";
import { runQuickCommand } from "./quickCommands";
import { solveSpoken } from "./spokenMath";
import TOOLS from "./routerTools.json";
import { calculate } from "../providers/agent/liveTools";
import { formatNumber } from "../providers/agent/graph";


/**
 * The instant router: before a request goes to the AI, Apple's on-device model (no tokens, about
 * half a second) decides whether one of these instant actions does the whole thing — "crank it
 * all the way up", "skip this", "what's 7 times 8", "where's my essay". The actions and what they
 * mean are described once (routerTools.json); nothing is written per phrasing. When it isn't
 * sure, the AI gets the request as before. It also learns: a request the AI answered with one
 * simple action is instant next time.
 */

export type Instant = { text: string; spoken: string; via: "learned" | "on-device" };

const LEARNED_KEY = "ev.routerLearned";
const MAX_WORDS = 18;

type Learned = { text: string; tool: string; values: Record<string, unknown> };

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9%' ]+/g, " ").replace(/\b(?:um+|uh+|please|hey|e\.?v|evie|eevee)\b/g, " ").replace(/\s+/g, " ").trim();
}

function learnedList(): Learned[] {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(LEARNED_KEY) ?? "[]") as Learned[];
  } catch {
    return [];
  }
}

/** A request the AI handled with exactly one simple action: instant next time. */
export function learnRoute(request: string, tool: string, values: Record<string, unknown>): void {
  const text = normalize(request);
  if (!text || text.split(" ").length > MAX_WORDS || !TOOLS.some((t) => t.name === tool)) return;
  const list = learnedList().filter((l) => l.text !== text);
  list.push({ text, tool, values });
  globalThis.localStorage?.setItem(LEARNED_KEY, JSON.stringify(list.slice(-300)));
}

/** The AI's simple actions, as router actions (for learning). */
export function routeFromAiCall(name: string, args: Record<string, unknown>): { tool: string; values: Record<string, unknown> } | null {
  switch (name) {
    case "mac_system":
      if (typeof args.dark_mode === "boolean" && args.volume === undefined && args.muted === undefined) return { tool: "dark_mode", values: { on: args.dark_mode } };
      if (typeof args.volume === "number" && typeof args.dark_mode !== "boolean") return { tool: "volume", values: { level: args.volume } };
      if (typeof args.muted === "boolean" && args.volume === undefined) return { tool: "volume", values: { muted: args.muted } };
      return null;
    case "mac_media": {
      const action = String(args.action);
      return { tool: "media", values: { action: action === "playpause" ? "play" : action } };
    }
    default:
      return null;
  }
}

function prefers24h(): boolean {
  return useVault.getState().memories.some((m) => /24[- ]hour/i.test(m.text));
}

function sayTime(text: string): { text: string; spoken: string } {
  const now = new Date();
  if (/\b(date|day|today|month|year)\b/i.test(text) && !/\btime\b/i.test(text)) {
    const date = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    return { text: `${date}.`, spoken: `${date}.` };
  }
  const time = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", ...(prefers24h() ? { hourCycle: "h23" as const } : {}) });
  return { text: `${time}.`, spoken: `${time}.` };
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** Does the action; throws when it can't (then the AI takes the request). */
async function run(tool: string, values: Record<string, unknown>, request: string): Promise<{ text: string; spoken: string }> {
  const one = (s: string) => ({ text: s, spoken: s });
  switch (tool) {
    case "volume": {
      if (typeof values.muted === "boolean") return one(String(await runQuickCommand({ kind: "mute", on: values.muted })));
      const level = num(values.level);
      if (level !== undefined) return one(String(await runQuickCommand({ kind: "volume", to: Math.max(0, Math.min(100, Math.round(level))) })));
      const change = num(values.change);
      const down = /\b(down|lower|quiet|quieter|soft|softer|less|too loud|reduce)\b/i.test(request);
      const by = change && change !== 0 ? Math.max(-100, Math.min(100, Math.round(change))) : down ? -10 : 10;
      if (/\b(all the way|max|maximum|full)\b/i.test(request)) return one(String(await runQuickCommand({ kind: "volume", to: down ? 0 : 100 })));
      return one(String(await runQuickCommand({ kind: "volume", by: down && by > 0 ? -by : by })));
    }
    case "media": {
      const action = String(values.action);
      if (!["play", "pause", "next", "previous"].includes(action)) throw new Error("no action");
      return one(String(await runQuickCommand({ kind: "media", action: action as "play" | "pause" | "next" | "previous" })));
    }
    case "dark_mode":
      if (typeof values.on !== "boolean") throw new Error("no value");
      return one(String(await runQuickCommand({ kind: "dark", on: values.on })));
    case "open_app": {
      const app = String(values.app ?? "").trim();
      if (!app || app.length > 40) throw new Error("no app");
      return one(String(await runQuickCommand({ kind: "open", app: app.replace(/\b\w/g, (c) => c.toUpperCase()) })));
    }
    case "find_file": {
      const found = await findFile(request);
      return typeof found === "string" ? one(found) : found;
    }
    case "calculate": {
      const spoken = solveSpoken(request);
      if (spoken) return { text: spoken.shown, spoken: spoken.spoken };
      const expression = String(values.expression ?? "");
      if (!/^[\d.\s+\-*/^()%sqrt]+$/.test(expression) || !/\d/.test(expression)) throw new Error("not arithmetic");
      const value = calculate(expression);
      if (!Number.isFinite(value)) throw new Error("no number");
      const answer = formatNumber(Math.round(value * 1e10) / 1e10);
      return { text: `${expression.replace(/\*/g, "×")} = **${answer}**`, spoken: `${answer}.` };
    }
    case "time":
      return sayTime(request);
    default:
      throw new Error(`unknown action ${tool}`);
  }
}

let warmed: Promise<boolean> | null = null;

/** Loads the on-device model in the background (first use would otherwise take ~2 s). */
export function prewarmRouter(): void {
  if (useSettings.getState().settings.router.enabled) warmed ??= routePrewarm().catch(() => false);
}

/**
 * The request done instantly, or null when the AI should take it (not sure, not an instant
 * action, the action failed, or the router is off / this Mac has no on-device model).
 */
export async function routeInstantly(request: string): Promise<Instant | null> {
  if (!useSettings.getState().settings.router.enabled) return null;
  const text = normalize(request);
  if (!text || text.split(" ").length > MAX_WORDS) return null;
  const learned = learnedList();
  const known = [...learned].reverse().find((l) => l.text === text);
  try {
    if (known) return { ...(await run(known.tool, known.values, request)), via: "learned" };
    const reply = await routeRequest({ tools: TOOLS, learned: learned.slice(-60).map(({ text, tool }) => ({ text, tool })), text: request });
    if (!reply.available || reply.tool === "none" || !reply.values) return null;
    return { ...(await run(reply.tool, reply.values, request)), via: "on-device" };
  } catch {
    return null;
  }
}

export const _forTests = { normalize };
