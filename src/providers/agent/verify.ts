import type { KeyedProviderId } from "../../types";
import type { AgentAdapter } from "./adapters";
import { userTimeZone } from "./liveTools";

/**
 * Fact-check pass: after an answer built on live data, a second request compares every claim in
 * the draft with what the tools actually returned, and either confirms it or rewrites it.
 */

export interface Source {
  title: string;
  output: string;
}

export type CheckOutcome = { verdict: "verified" } | { verdict: "corrected"; text: string } | { verdict: "unchecked" };

const SOURCE_LIMIT = 8_000;
const TOTAL_LIMIT = 48_000;

export function checkerSystemPrompt(now = new Date()): string {
  const stamp = now.toLocaleString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  return [
    "You check an AI assistant's draft answer against the sources its tools returned, before the user sees it.",
    `Now: ${stamp}. The user's time zone: ${userTimeZone()}.`,
    "Check every factual claim — names, numbers, dates, days of the week, times and their time zones, prices, scores, rankings, quotes — against the sources.",
    "Times must be in the user's time zone unless the user asked otherwise; a time copied from a source in UTC or another zone without converting is wrong.",
    "When sources disagree, the answer must say so briefly or follow the most official / most recent source.",
    "You may also get the list of actions the assistant really carried out (on the Mac, in apps or in web pages) with their results. Those are facts too: never remove, deny or doubt an action listed as done, and never add that the assistant can't act, has no access, or only has the sources. Only check claims that come from the sources.",
    "Reply in exactly one of these two forms:",
    "1. If every claim is supported by the sources (or is timeless general knowledge), reply with the single word: VERIFIED",
    "2. Otherwise reply with CORRECTED on the first line, then the complete corrected answer for the user — same language, tone and format as the draft, wrong or unsupported claims fixed from the sources or removed. Never add facts that are not in the sources. Do not mention this check.",
  ].join("\n");
}

export function checkerRequest(question: string, sources: Source[], draft: string, actions: string[] = []): string {
  let budget = TOTAL_LIMIT;
  const blocks: string[] = [];
  for (const [i, source] of sources.entries()) {
    if (budget <= 0) break;
    const body = source.output.slice(0, Math.min(SOURCE_LIMIT, budget));
    budget -= body.length;
    blocks.push(`[${i + 1}] ${source.title}\n${body}`);
  }
  const done = actions.length ? `\n\nActions the assistant carried out (✓ worked, ✗ failed):\n${actions.slice(-60).join("\n")}` : "";
  return `User's question:\n${question}\n\nSources:\n${blocks.join("\n\n")}${done}\n\nDraft answer:\n${draft}`;
}

/** "I can't…", "no access", "I only have the notes": a rewrite claiming E.V couldn't act. */
const CANT_ACT = /\b(?:can(?:no|')t|could(?:n't| not)|unable to|no access|don't have access|do not have access|only have (?:the|your|his|her)|not able to)\b/i;

export function parseVerdict(reply: string, draft: string, actions: string[] = []): CheckOutcome {
  const text = reply.trim();
  if (/^VERIFIED\b/i.test(text)) return { verdict: "verified" };
  const corrected = /^CORRECTED\b[:\s]*\n?([\s\S]*)$/i.exec(text);
  if (corrected) {
    const body = corrected[1].trim();
    // A rewrite that says the assistant couldn't act, when its actions worked and the draft didn't
    // say so, contradicts what really happened: keep the draft.
    if (actions.some((a) => a.startsWith("✓")) && CANT_ACT.test(body) && !CANT_ACT.test(draft)) return { verdict: "unchecked" };
    return body && body !== draft.trim() ? { verdict: "corrected", text: body } : { verdict: "verified" };
  }
  return { verdict: "unchecked" };
}

/** One user turn in the provider's own format. */
export function userTurn(provider: KeyedProviderId, text: string): unknown {
  return provider === "gemini" ? { role: "user", parts: [{ text }] } : { role: "user", content: text };
}

/** Puts the checked answer into the saved model turn, so later turns don't replay the draft. */
export function withAnswerText(provider: KeyedProviderId, item: unknown, text: string): unknown {
  if (provider === "gemini") {
    const content = item as { role: string; parts: { text?: string; thought?: boolean }[] };
    const others = content.parts.filter((p) => p.text === undefined || p.thought);
    return { ...content, parts: [...others, { text }] };
  }
  return { ...(item as object), content: text };
}

export async function factCheck(options: {
  adapter: AgentAdapter;
  model: string;
  key: string;
  question: string;
  sources: Source[];
  draft: string;
  /** What the task really did ("✓ Change 6 things on cstimer — 6 done"), so the check can't undo it. */
  actions?: string[];
  signal: AbortSignal;
}): Promise<{ outcome: CheckOutcome; headers: Record<string, string> }> {
  const { adapter, model, key, question, sources, draft, signal } = options;
  const actions = options.actions ?? [];
  const result = await adapter.step({
    model,
    key,
    system: checkerSystemPrompt(),
    conversation: [userTurn(adapter.provider, checkerRequest(question, sources, draft, actions))],
    tools: [],
    signal,
    onText: () => {},
  });
  return { outcome: parseVerdict(result.text, draft, actions), headers: result.headers };
}
