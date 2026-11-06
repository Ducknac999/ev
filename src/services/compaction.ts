import { ADAPTERS } from "../providers/agent/adapters";
import { keyEngine } from "../providers/keyPool";
import { useChats } from "../store/chats";
import type { Chat, ChatMessage, KeyedProviderId } from "../types";

/**
 * Long chats, like Claude Code's auto-compact: once more than COMPACT_AT messages would be sent,
 * the older ones are folded into a running summary with the chat's own model, and only the summary
 * plus the latest KEEP_RECENT messages go to the model. Nothing is deleted from the chat itself.
 */
export const COMPACT_AT = 40;
export const KEEP_RECENT = 16;

const PER_MESSAGE = 4_000;
const TOTAL = 150_000;

/** Plain-text transcript of messages for the summarizer: words plus a line per action and its result. */
export function transcriptText(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const who = m.role === "user" ? "User" : "E.V";
    const files = m.attachments?.length ? ` [attached: ${m.attachments.map((a) => a.name).join(", ")}]` : "";
    const actions = (m.blocks ?? [])
      .flatMap((b) => (b.type === "tool" ? [`  • ${b.step.title} — ${b.step.status}${b.step.result ? `: ${b.step.result.replace(/\s+/g, " ").slice(0, 240)}` : ""}`] : []))
      .join("\n");
    const text = m.content.length > PER_MESSAGE ? `${m.content.slice(0, PER_MESSAGE)} …[cut]` : m.content;
    lines.push(`${who}:${files} ${text}${actions ? `\n${actions}` : ""}`);
  }
  const all = lines.join("\n\n");
  return all.length > TOTAL ? `…[earliest part cut]\n${all.slice(all.length - TOTAL)}` : all;
}

const SUMMARY_SYSTEM = [
  "You compress a conversation between a user and E.V (an AI agent on their Mac) so it can continue without the full history. Write a summary another AI can pick up from seamlessly. Include:",
  "1. The user's goals and requests — quote their exact wording for instructions and preferences.",
  "2. What was done: files read, created or changed (full paths), documents made, commands run and their results, apps and sites used.",
  "3. Decisions, facts, numbers, names and answers that later messages may rely on.",
  "4. Problems hit and how they were solved, and anything that failed.",
  "5. Current state and what's still pending or was promised next.",
  "Be specific and complete; leave out greetings and chit-chat. Plain text with short headed sections. No preamble.",
].join("\n");

/** Splits off what to fold: everything but the recent tail, which must start on a user message. */
export function splitForCompaction(pending: ChatMessage[], keep = KEEP_RECENT): { fold: ChatMessage[]; recent: ChatMessage[] } {
  let cut = Math.max(0, pending.length - keep);
  while (cut < pending.length && pending[cut].role !== "user") cut++;
  return { fold: pending.slice(0, cut), recent: pending.slice(cut) };
}

/** Asks the chat's own model for an updated summary that includes `messages`. */
export async function summarize(chat: Chat, previous: string | undefined, messages: ChatMessage[], signal: AbortSignal): Promise<string> {
  const provider = chat.model.provider as KeyedProviderId;
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error("this model can't summarize");
  const body = `${previous ? `Summary of the conversation before this part:\n${previous}\n\n` : ""}Conversation to add:\n${transcriptText(messages)}\n\nWrite the updated summary of everything above.`;
  const conversation = provider === "gemini" ? [{ role: "user", parts: [{ text: body }] }] : [{ role: "user", content: body }];
  let text = "";
  await keyEngine.execute({ provider, model: chat.model.model, chatId: `${chat.id}#compact`, pinnedKeyId: chat.pinnedKeyId }, async (key) => {
    text = "";
    const out = await adapter.step({ model: chat.model.model, key: key.key, system: SUMMARY_SYSTEM, conversation, tools: [], signal, onText: (d) => void (text += d) });
    return out.headers;
  });
  if (!text.trim()) throw new Error("the model returned an empty summary");
  return text.trim();
}

/** The model-facing note that carries the summary in front of the recent messages. */
export function summaryNote(summary: string): string {
  return `Summary of the earlier part of this conversation (folded to keep requests small — treat it as what was said and done before):\n${summary}`;
}

/**
 * /compact: folds everything sent so far into the summary now. Returns how many messages were
 * folded (0 when there was nothing new).
 */
export async function compactNow(chatId: string, pending: ChatMessage[], signal: AbortSignal): Promise<number> {
  const chat = useChats.getState().chats.find((c) => c.id === chatId);
  if (!chat || pending.length === 0) return 0;
  const summary = await summarize(chat, chat.compact?.summary, pending, signal);
  useChats.getState().setCompact(chatId, { through: pending[pending.length - 1].id, summary, count: (chat.compact?.count ?? 0) + pending.length }, true);
  return pending.length;
}
