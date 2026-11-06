import { ADAPTERS } from "../providers/agent/adapters";
import { HELPER_MODEL } from "../providers/agent/helpers";
import { DEEPSEEK_FLASH } from "../providers/catalog";
import { keyEngine } from "../providers/keyPool";
import { useChats } from "../store/chats";
import type { ChatMessage, KeyedProviderId } from "../types";

/**
 * E.V names AI chats after what they're about ("Desmos Graphing", "Veritasium Latest Video")
 * once the first answer is in — and again after /clear. A name the user typed always wins.
 * One small Flash-Lite request (DeepSeek Flash when Gemini has no keys); if it can't be made, the chat
 * keeps its first-message name.
 */

const naming = new Set<string>();

/** Tidies the model's reply into a 2–5 word name, or null. */
export function cleanName(raw: string): string | null {
  const line = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const name = line
    .replace(/^(?:title|name)\s*:\s*/i, "")
    .replace(/^["'“”‘’*`#\s]+|["'“”‘’*`.\s]+$/g, "")
    .trim();
  const words = name.split(/\s+/).filter(Boolean);
  if (!name || words.length > 6 || name.length > 48) return null;
  return name;
}

function topic(messages: ChatMessage[]): string {
  const user = messages.find((m) => m.role === "user" && m.content.trim());
  const reply = messages.find((m) => m.role === "assistant" && m.content.trim() && !m.divider);
  if (!user) return "";
  return `User: ${user.content.slice(0, 600)}\n\nAssistant: ${(reply?.content ?? "").slice(0, 600)}`;
}

export async function nameChat(chatId: string): Promise<void> {
  const chat = useChats.getState().chats.find((c) => c.id === chatId);
  if (!chat || chat.kind !== "ai" || chat.titleIsCustom || chat.aiNamed || naming.has(chatId)) return;
  const text = topic(chat.messages.slice(chat.contextStart ?? 0));
  if (!text) return;
  const helper: { provider: KeyedProviderId; model: string } = keyEngine.totals("gemini", HELPER_MODEL).usable
    ? { provider: "gemini", model: HELPER_MODEL }
    : { provider: "deepseek", model: DEEPSEEK_FLASH.model };
  if (!keyEngine.totals(helper.provider, helper.model).usable) return;
  naming.add(chatId);
  try {
    let reply = "";
    await keyEngine.execute({ provider: helper.provider, model: helper.model, chatId: `${chatId}#name` }, async (key) => {
      reply = "";
      const out = await ADAPTERS[helper.provider].step({
        model: helper.model,
        key: key.key,
        system:
          "Name this chat by its topic in 2 to 4 words, Title Case, like a folder name: e.g. \"Desmos Graphing\", \"Veritasium Latest Video\", \"Monkey Facts\", \"E.V Project\". Reply with the name only — no quotes, no punctuation, no explanation.",
        conversation: [helper.provider === "gemini" ? { role: "user", parts: [{ text }] } : { role: "user", content: text }],
        tools: [],
        signal: new AbortController().signal,
        onText: (delta) => void (reply += delta),
      });
      return out.headers;
    });
    const name = cleanName(reply);
    if (name) useChats.getState().setAiTitle(chatId, name);
  } catch {
    // Keeps the first-message name; it can be renamed any time.
  } finally {
    naming.delete(chatId);
  }
}
