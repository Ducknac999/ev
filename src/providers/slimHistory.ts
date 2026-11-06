/**
 * Earlier tasks in a chat are sent again with every new request (and on every step of it). Their
 * full window looks and click reports are out of date by then — control numbers change — so they
 * go as a short version: what was done and what came of it, never the old control lists. The
 * short version is the same every time, so the provider's cache still covers it.
 */

const LOOK_LIMIT = 160;
const RESULT_LIMIT = 320;
const NOTE_LIMIT = 240;

/** A window look (mac_look / browser look): its first line, without the control list. */
function isLook(text: string): boolean {
  return /\nControls(?: \(current numbers\))?:\n/.test(text) || /\n#\d+ \w/.test(text);
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+\n/g, "\n").trim();
  return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}…` : flat;
}

/** A tool result from an earlier task. */
export function slimResult(text: string): string {
  if (isLook(text)) {
    const head = text.split("\n").find((line) => line.trim() && !/^(?:Controls|Changed|Window now)\b/.test(line)) ?? "";
    const change = /\bnothing changed\b/i.test(text) ? " Nothing changed." : "";
    return `${clip(head, LOOK_LIMIT)}${change} [old control list left out — look again for current numbers]`;
  }
  return clip(text, RESULT_LIMIT);
}

/** E.V's own notes inside an earlier task ("Before you answer: …"). */
function slimNote(text: string): string {
  return clip(text, NOTE_LIMIT);
}

interface OpenAiItem {
  role: string;
  content?: unknown;
  reasoning_content?: string;
  [key: string]: unknown;
}

/** Chat-completions items (DeepSeek, Groq) of an earlier turn. */
export function slimOpenAiItems(items: unknown[]): unknown[] {
  return items.map((raw) => {
    const item = raw as OpenAiItem;
    if (item.role === "tool" && typeof item.content === "string") return { ...item, content: slimResult(item.content) };
    if (item.role === "user" && typeof item.content === "string") return { ...item, content: slimNote(item.content) };
    if (item.role === "user" && Array.isArray(item.content)) {
      return { ...item, content: (item.content as { type?: string; text?: string }[]).map((p) => (p?.type === "text" && typeof p.text === "string" ? { ...p, text: slimNote(p.text) } : p)) };
    }
    // Old thinking is never needed again; the field stays (empty) because DeepSeek wants it when Think is on.
    if (item.role === "assistant" && typeof item.reasoning_content === "string" && item.reasoning_content) return { ...item, reasoning_content: "" };
    return item;
  });
}

interface GeminiItem {
  role: string;
  parts: Record<string, unknown>[];
}

/** Gemini contents of an earlier turn. Thought signatures stay: Gemini checks them. */
export function slimGeminiItems(items: unknown[]): unknown[] {
  return items.map((raw) => {
    const item = raw as GeminiItem;
    if (!Array.isArray(item.parts)) return item;
    return {
      ...item,
      parts: item.parts.map((p) => {
        const fr = p.functionResponse as { response?: { result?: unknown } } | undefined;
        if (fr?.response && typeof fr.response.result === "string") return { ...p, functionResponse: { ...fr, response: { ...fr.response, result: slimResult(fr.response.result) } } };
        if (item.role === "user" && typeof p.text === "string" && !p.thoughtSignature) return { ...p, text: slimNote(p.text) };
        return p;
      }),
    };
  });
}

/** "Brave Browser — window …" → "Brave Browser" (null if it isn't a window look). */
function lookApp(text: string): string | null {
  if (!/\nControls:\n/.test(text)) return null;
  const m = /^(.+?) — window "/.exec(text);
  return m ? m[1] : null;
}

/**
 * Within one task: once a newer look of the same app is in, the older ones are out of date (their
 * control numbers no longer hold), so they shrink to one line. Done to the turn's own items as soon
 * as the newer look arrives, so every later call sends the same thing (the cache still covers it).
 */
export function supersedeLooks(provider: string, items: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out = [...items];
  for (let i = out.length - 1; i >= 0; i--) {
    if (provider === "gemini") {
      const item = out[i] as GeminiItem;
      if (!Array.isArray(item?.parts)) continue;
      let changed = false;
      const parts = item.parts.map((p) => {
        const fr = p.functionResponse as { response?: { result?: unknown } } | undefined;
        const text = typeof fr?.response?.result === "string" ? fr.response.result : null;
        const app = text ? lookApp(text) : null;
        if (!app || !text) return p;
        if (!seen.has(app)) {
          seen.add(app);
          return p;
        }
        changed = true;
        return { ...p, functionResponse: { ...fr, response: { ...fr!.response, result: slimResult(text) } } };
      });
      if (changed) out[i] = { ...item, parts };
      continue;
    }
    const item = out[i] as OpenAiItem;
    if (item?.role !== "tool" || typeof item.content !== "string") continue;
    const app = lookApp(item.content);
    if (!app) continue;
    if (!seen.has(app)) seen.add(app);
    else out[i] = { ...item, content: slimResult(item.content) };
  }
  return out;
}
