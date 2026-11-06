import { providerStream } from "../../lib/ipc";
import { GEMINI_FLASH } from "../catalog";
import { keyEngine } from "../keyPool";
import { SseParser } from "../sse";

export const SEARCH_TRACKING_ID = `${GEMINI_FLASH.model}+search`;

interface GroundingChunk {
  web?: { uri?: string; title?: string };
}

/**
 * Web search for any agent, answered by Gemini with Google Search grounding. Uses the Gemini
 * key pool, so it works the same whichever model the chat runs on.
 */
export async function geminiWebSearch(query: string, chatId: string, signal: AbortSignal): Promise<string> {
  let text = "";
  const sources = new Map<string, string>();
  try {
    await searchWithPool(query, chatId, signal, (t) => (text = t), sources);
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Error(
      `Web search is unavailable: Google refused search on every Gemini key (${err instanceof Error ? err.message : String(err)}). Do not retry web_search in this task; open a specific site with web_fetch instead, or tell the user.`,
    );
  }
  const list = [...sources].slice(0, 8).map(([uri, title], i) => `[${i + 1}] ${title} — ${uri}`);
  return `${text.trim() || "No answer found."}${list.length ? `\n\nSources:\n${list.join("\n")}` : ""}`;
}

async function searchWithPool(
  query: string,
  chatId: string,
  signal: AbortSignal,
  setText: (text: string) => void,
  sources: Map<string, string>,
): Promise<void> {
  // Search grounding has its own quota, so its limits are tracked apart from the chat model's:
  // a refused search must never put every key on cooldown for the chat itself.
  let text = "";
  await keyEngine.execute({ provider: "gemini", model: SEARCH_TRACKING_ID, chatId }, async (key) => {
    setText((text = ""));
    sources.clear();
    const parser = new SseParser((data) => {
      const payload = JSON.parse(data);
      if (payload.error) throw new Error(payload.error.message ?? "search failed");
      const candidate = payload.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) if (part.text && !part.thought) setText((text += part.text));
      for (const chunk of (candidate?.groundingMetadata?.groundingChunks ?? []) as GroundingChunk[]) {
        if (chunk.web?.uri) sources.set(chunk.web.uri, chunk.web.title ?? chunk.web.uri);
      }
    });
    const headers = await providerStream(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FLASH.model}:streamGenerateContent?alt=sse`,
      { "x-goog-api-key": key.key, "Content-Type": "application/json" },
      {
        contents: [{ role: "user", parts: [{ text: `Search the web and answer concisely with facts and dates: ${query}` }] }],
        tools: [{ googleSearch: {} }],
      },
      (chunk) => parser.push(chunk),
      signal,
    );
    parser.flush();
    if (parser.error) throw parser.error;
    return headers;
  });
}
