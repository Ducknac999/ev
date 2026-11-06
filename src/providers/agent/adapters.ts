import { uid } from "../../lib/ids";
import { providerStream } from "../../lib/ipc";
import type { KeyedProviderId } from "../../types";
import type { ChatCompletionMessage, GeminiContent } from "../attachmentPayload";
import { apiModel, PROVIDER_BASE, seesImages } from "../catalog";
import { useSettings } from "../../store/settings";
import { SseParser } from "../sse";
import type { ToolDefinition } from "./tools";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface TurnRequest {
  model: string;
  key: string;
  system: string;
  /** Provider-native conversation so far (history + this turn's earlier items). */
  conversation: unknown[];
  tools: ToolDefinition[];
  signal: AbortSignal;
  onText: (delta: string) => void;
  /** Models with a thinking switch (DeepSeek): reason before answering. */
  thinking?: boolean;
  onThinking?: (delta: string) => void;
}

/** Tokens one step used, as the provider counted them. `cached`: input billed at the cache price. */
export interface TokenUsage {
  input: number;
  cached: number;
  output: number;
}

export interface TurnResult {
  usage?: TokenUsage;
  text: string;
  calls: ToolCall[];
  /** The model's output in provider-native form, appended to the conversation. */
  item: unknown;
  headers: Record<string, string>;
}

export interface ToolResult {
  call: ToolCall;
  output: string;
  /** JPEG (base64) the model should see, e.g. an app window. */
  image?: string;
  /** Several pictures, e.g. a document's pages. */
  images?: string[];
}

/** Every picture a result carries, in order. */
export function picturesOf(result: ToolResult): string[] {
  return [...(result.image ? [result.image] : []), ...(result.images ?? [])].filter(Boolean);
}

/** One provider's wire format for an agent step: stream a reply, then feed tool results back. */
export interface AgentAdapter {
  provider: KeyedProviderId;
  step: (request: TurnRequest) => Promise<TurnResult>;
  /** `model` decides whether pictures are sent (OpenAI-format models differ per model). */
  toolResults: (results: ToolResult[], model?: string) => unknown[];
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

// ── Gemini ────────────────────────────────────────────────────────────────────

interface GeminiPartOut {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: unknown; id?: string };
}

export const geminiAdapter: AgentAdapter = {
  provider: "gemini",
  async step({ model, key, system, conversation, tools, signal, onText }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    const parts: GeminiPartOut[] = [];
    let finishReason = "";
    let text = "";
    let usage: TokenUsage | undefined;
    const parser = new SseParser((data) => {
      const payload = JSON.parse(data);
      if (payload.error) throw new Error(payload.error.message ?? "stream error");
      const meta = payload.usageMetadata;
      if (meta && typeof meta.promptTokenCount === "number") {
        usage = { input: meta.promptTokenCount, cached: meta.cachedContentTokenCount ?? 0, output: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0) };
      }
      const candidate = payload.candidates?.[0];
      if (candidate?.finishReason) finishReason = candidate.finishReason;
      for (const part of (candidate?.content?.parts ?? []) as GeminiPartOut[]) {
        parts.push(part);
        if (part.text && !part.thought) {
          text += part.text;
          onText(part.text);
        }
      }
    });
    const headers = await providerStream(
      url,
      { "x-goog-api-key": key, "Content-Type": "application/json" },
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: conversation,
        ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
      },
      (chunk) => parser.push(chunk),
      signal,
    );
    parser.flush();
    if (parser.error) throw parser.error;

    const calls: ToolCall[] = parts
      .filter((p) => p.functionCall?.name)
      .map((p) => ({ id: p.functionCall!.id ?? uid("call-"), name: p.functionCall!.name, args: parseArgs(p.functionCall!.args) }));
    if (!text && calls.length === 0 && finishReason && finishReason !== "STOP") {
      throw new Error(`Gemini stopped without a reply (${finishReason}).`);
    }
    // Keep thought signatures; merge streamed text fragments so replays stay compact.
    const merged: GeminiPartOut[] = [];
    for (const part of parts) {
      const last = merged.at(-1);
      if (part.text !== undefined && !part.thought && !part.thoughtSignature && last?.text !== undefined && !last.thought && !last.functionCall) {
        last.text += part.text;
      } else {
        merged.push({ ...part });
      }
    }
    const item: GeminiContent = { role: "model", parts: merged.filter((p) => p.functionCall || p.thoughtSignature || p.text) as never };
    return { text, calls, item, headers, usage };
  },
  toolResults(results) {
    return [
      {
        role: "user",
        parts: [
          ...results.map(({ call, output }) => ({
            functionResponse: { name: call.name, ...(call.id.startsWith("call-") ? {} : { id: call.id }), response: { result: output } },
          })),
          ...results.flatMap((r) => {
            const pictures = picturesOf(r);
            return pictures.flatMap((data, i) => [
              { text: pictures.length > 1 ? `Picture ${i + 1} of ${pictures.length} from ${r.call.name}:` : `Picture from ${r.call.name}:` },
              { inlineData: { mimeType: "image/jpeg", data } },
            ]);
          }),
        ],
      },
    ];
  },
};

// ── OpenAI-compatible (Groq, DeepSeek, and future ChatGPT / Grok / Ollama) ──────

/** Chat-completions address: the provider's own, or the user's custom server (Settings → Providers). */
function endpoint(provider: KeyedProviderId): string {
  const base = provider === "custom" ? useSettings.getState().settings.customServer.baseUrl.trim().replace(/\/+$/, "") : (PROVIDER_BASE[provider] ?? "");
  return `${base}/chat/completions`;
}

/**
 * `vision`: the model accepts pictures. Tool messages can only hold text, so pictures follow in
 * one user message. Models without vision still get every picture's words (documents are read
 * with OCR), plus a note that a picture exists. `thinkingSwitch`: the provider reasons by default
 * and takes `thinking: { type }` (DeepSeek).
 */
function openAiAdapter(provider: KeyedProviderId, vision: (model: string) => boolean, thinkingSwitch = false): AgentAdapter {
  return {
    provider,
    async step({ model, key, system, conversation, tools, signal, onText, thinking = false, onThinking }) {
      let text = "";
      let reasoning = "";
      let usage: TokenUsage | undefined;
      const pending = new Map<number, { id: string; name: string; args: string }>();
      const parser = new SseParser((data) => {
        if (data === "[DONE]") return;
        const payload = JSON.parse(data);
        if (payload.error) throw new Error(payload.error.message ?? "stream error");
        const u = payload.usage ?? payload.x_groq?.usage;
        if (u && typeof u.prompt_tokens === "number") {
          usage = { input: u.prompt_tokens, cached: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0, output: u.completion_tokens ?? 0 };
        }
        const delta = payload.choices?.[0]?.delta ?? {};
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          onThinking?.(delta.reasoning_content);
        }
        if (typeof delta.content === "string" && delta.content) {
          text += delta.content;
          onText(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const entry = pending.get(tc.index ?? 0) ?? { id: "", name: "", args: "" };
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
          pending.set(tc.index ?? 0, entry);
        }
      });
      let history = conversation as ChatCompletionMessage[];
      // DeepSeek rejects a thinking request with tools unless every earlier assistant message carries
      // its reasoning; replies made without thinking (or by another model) have none to send.
      if (thinkingSwitch && thinking) history = history.map((m) => (m.role === "assistant" && m.reasoning_content === undefined ? { ...m, reasoning_content: "" } : m));
      const messages: ChatCompletionMessage[] = [{ role: "system", content: system }, ...history];
      const headers = await providerStream(
        endpoint(provider),
        { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "text/event-stream" },
        {
          model: apiModel(model),
          messages,
          stream: true,
          // DeepSeek sends the token counts (with how many came from its cache) in the last chunk.
          ...(provider === "deepseek" ? { stream_options: { include_usage: true } } : {}),
          ...(thinkingSwitch ? { thinking: { type: thinking ? "enabled" : "disabled" } } : {}),
          ...(tools.length
            ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) }
            : {}),
        },
        (chunk) => parser.push(chunk),
        signal,
      );
      parser.flush();
      if (parser.error) throw parser.error;
      const calls: ToolCall[] = [...pending.values()]
        .filter((c) => c.name)
        .map((c) => ({ id: c.id || uid("call-"), name: c.name, args: parseArgs(c.args) }));
      const item: ChatCompletionMessage = {
        role: "assistant",
        content: text || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(calls.length
          ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
          : {}),
      };
      return { text, calls, item, headers, usage };
    },
    toolResults(results, model = "") {
      const sees = vision(model);
      const messages: unknown[] = results.map((r) => ({
        role: "tool",
        tool_call_id: r.call.id,
        content:
          picturesOf(r).length && !sees
            ? `${r.output}\n(${picturesOf(r).length > 1 ? "Pictures were" : "A picture was"} taken but this model can't view images; work from the text above — it includes the words found in the pictures.)`
            : r.output,
      }));
      const pictures = sees ? results.flatMap((r) => picturesOf(r).map((data) => ({ name: r.call.name, data }))) : [];
      if (pictures.length) {
        messages.push({
          role: "user",
          content: pictures.flatMap(({ name, data }, i) => [
            { type: "text", text: `Picture ${i + 1} of ${pictures.length} (from ${name}):` },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${data}` } },
          ]),
        });
      }
      return messages;
    },
  };
}

export const ADAPTERS: Record<KeyedProviderId, AgentAdapter> = {
  gemini: geminiAdapter,
  groq: openAiAdapter("groq", () => false),
  deepseek: openAiAdapter("deepseek", seesImages, true),
  openai: openAiAdapter("openai", () => true),
  openrouter: openAiAdapter("openrouter", () => false),
  xai: openAiAdapter("xai", () => true),
  anthropic: openAiAdapter("anthropic", () => true),
  mistral: openAiAdapter("mistral", () => false),
  ollama: openAiAdapter("ollama", () => false),
  custom: openAiAdapter("custom", () => false),
};

/** Shrinks tool outputs inside a transcript before it is saved with the chat. */
export function compactTranscript(provider: KeyedProviderId, items: unknown[], limit = 6000): unknown[] {
  const clip = (s: string) => (s.length > limit ? `${s.slice(0, limit)}\n…[trimmed for storage]` : s);
  return items.map((item) => {
    if (provider === "gemini") {
      const content = item as { role: string; parts: Record<string, unknown>[] };
      return {
        ...content,
        parts: content.parts.map((p) => {
          // Pictures are only for the moment they were taken; saved chats keep a note instead.
          if (p.inlineData) return { text: "[picture omitted]" };
          const fr = p.functionResponse as { response?: { result?: unknown } } | undefined;
          if (fr?.response && typeof fr.response.result === "string") {
            return { ...p, functionResponse: { ...fr, response: { result: clip(fr.response.result) } } };
          }
          return p;
        }),
      };
    }
    const message = item as ChatCompletionMessage;
    if (message.role === "user" && Array.isArray(message.content)) {
      return { ...message, content: (message.content as { type?: string }[]).map((p) => (p?.type === "image_url" ? { type: "text", text: "[picture omitted]" } : p)) };
    }
    return message.role === "tool" && typeof message.content === "string" ? { ...message, content: clip(message.content) } : message;
  });
}
