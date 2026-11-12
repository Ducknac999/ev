import { GEMINI_INLINE_BUDGET, MAX_TEXT_CHARS } from "../lib/attachments";
import { attachmentRead } from "../lib/ipc";
import type { Attachment, ChatMessage } from "../types";
import { slimGeminiItems, slimOpenAiItems } from "./slimHistory";

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export type ChatCompletionPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatCompletionPart[] | null;
  /** DeepSeek thinking: kept so later requests can send it back. */
  reasoning_content?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

/** Reads a stored attachment; null when the file has since been deleted. */
export type AttachmentLoader = (path: string) => Promise<ArrayBuffer | null>;

export const loadAttachment: AttachmentLoader = (path) => attachmentRead(path).catch(() => null);

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function textBlock(name: string, buffer: ArrayBuffer): string {
  let text = new TextDecoder().decode(buffer);
  let note = "";
  if (text.length > MAX_TEXT_CHARS) {
    note = `\n[… truncated: showing the first ${MAX_TEXT_CHARS.toLocaleString()} of ${text.length.toLocaleString()} characters]`;
    text = text.slice(0, MAX_TEXT_CHARS);
  }
  const fence = text.includes("```") ? "~~~~" : "```";
  return `Attached file: ${name}\n${fence}\n${text}\n${fence}${note}`;
}

const missing = (a: Attachment) => `[Attached file "${a.name}" is no longer available]`;

/**
 * Builds Gemini `contents`, inlining attachments. Gemini is stateless, so earlier files are
 * re-sent each turn; when they no longer fit the ~20 MB request budget the oldest are replaced
 * by a short note.
 */
export async function geminiContents(history: ChatMessage[], load: AttachmentLoader = loadAttachment): Promise<GeminiContent[]> {
  let budget = GEMINI_INLINE_BUDGET;
  const built: GeminiContent[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    // Earlier agent turns replay exactly as Gemini produced them (tool calls, signatures, results).
    if (m.role === "assistant" && m.transcript?.provider === "gemini" && m.transcript.items.length) {
      for (const item of [...slimGeminiItems(m.transcript.items)].reverse()) built.push(item as GeminiContent);
      continue;
    }
    const parts: GeminiPart[] = [];
    if (m.hiddenContext) parts.push({ text: m.hiddenContext });
    for (const a of m.attachments ?? []) {
      if (a.kind === "text") {
        const buffer = await load(a.path);
        parts.push({ text: buffer ? textBlock(a.name, buffer) : missing(a) });
        continue;
      }
      if (a.size > budget) {
        parts.push({ text: `[Earlier attachment "${a.name}" omitted to stay within the request size limit]` });
        continue;
      }
      const buffer = await load(a.path);
      if (!buffer) {
        parts.push({ text: missing(a) });
        continue;
      }
      budget -= buffer.byteLength;
      parts.push({ inlineData: { mimeType: a.mime, data: toBase64(new Uint8Array(buffer)) } });
    }
    if (m.content.trim()) parts.push({ text: m.content });
    if (m.role === "assistant" && m.blocks?.some((b) => b.type === "tool")) parts.push({ text: actionSummary(m) });
    if (parts.length) built.push({ role: m.role === "assistant" ? "model" : "user", parts });
  }
  return built.reverse();
}

/**
 * Chat-completions messages: text files are pasted in, other files noted. With `vision`, the user's
 * pictures go in as images (only user messages may carry them).
 */
export async function textOnlyMessages(
  history: ChatMessage[],
  load: AttachmentLoader = loadAttachment,
  vision = false,
): Promise<ChatCompletionMessage[]> {
  const out: ChatCompletionMessage[] = [];
  for (const m of history) {
    const provider = m.transcript?.provider;
    if (m.role === "assistant" && (provider === "groq" || provider === "deepseek") && m.transcript!.items.length) {
      const items = slimOpenAiItems(m.transcript!.items) as ChatCompletionMessage[];
      // E.V's own record of what the turn did goes with its final words, so a wrong earlier claim
      // ("I can't change pages there") never outweighs steps that worked.
      const last = items.at(-1);
      if (last && last.role === "assistant" && !last.tool_calls && m.blocks?.some((b) => b.type === "tool")) {
        items[items.length - 1] = { ...last, content: `${typeof last.content === "string" ? last.content : ""}\n\n${actionRecord(m)}`.trim() };
      }
      out.push(...items);
      continue;
    }
    const blocks: string[] = [];
    const images: ChatCompletionPart[] = [];
    if (m.hiddenContext) blocks.push(m.hiddenContext);
    for (const a of m.attachments ?? []) {
      if (vision && m.role === "user" && a.kind === "image") {
        const buffer = await load(a.path);
        if (!buffer) {
          blocks.push(missing(a));
          continue;
        }
        blocks.push(`[Attached image "${a.name}"]`);
        images.push({ type: "image_url", image_url: { url: `data:${a.mime || "image/jpeg"};base64,${toBase64(new Uint8Array(buffer))}` } });
        continue;
      }
      if (a.kind !== "text") {
        blocks.push(`[Attached ${a.kind} "${a.name}" — this model can't view it]`);
        continue;
      }
      const buffer = await load(a.path);
      blocks.push(buffer ? textBlock(a.name, buffer) : missing(a));
    }
    if (m.content.trim()) blocks.push(m.content);
    if (m.role === "assistant" && m.blocks?.some((b) => b.type === "tool")) blocks.push(actionSummary(m));
    if (images.length) out.push({ role: m.role, content: [{ type: "text", text: blocks.join("\n\n") }, ...images] });
    else if (blocks.length) out.push({ role: m.role, content: blocks.join("\n\n") });
  }
  return out;
}

/** Plain-text record of actions from a turn another provider ran, so a switched model knows. */
/** What a turn really did, step by step with results, for later turns to rely on. */
function actionRecord(m: ChatMessage): string {
  const steps = (m.blocks ?? []).flatMap((b) => (b.type === "tool" ? [b.step] : [])).slice(-40);
  const mark = (status: string) => (status === "done" ? "✓" : status === "denied" || status === "error" ? "✗" : "…");
  return `[E.V's record of this turn: ${steps.map((s) => `${mark(s.status)} ${s.title}${s.result ? ` — ${String(s.result).slice(0, 80)}` : ""}`).join("; ")}]`;
}

export function actionSummary(m: ChatMessage): string {
  const steps = (m.blocks ?? []).flatMap((b) => (b.type === "tool" ? [b.step] : []));
  return `[Actions taken: ${steps.map((s) => `${s.title} (${s.status})`).join("; ")}]`;
}
