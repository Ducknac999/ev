import type { KeyedProviderId, ModelRef, ProviderId, Settings } from "../types";

export interface ModelInfo {
  id: string;
  label: string;
  /**
   * Estimated free-tier requests per day, used for the usage bar until Google reports the real
   * limit in a 429 response or the user types it in Settings. 0 means not on the free tier.
   */
  freeDailyEstimate?: number;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Locked providers may only be assigned to one active chat at a time. */
  locked: boolean;
  models: ModelInfo[];
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  claude: {
    id: "claude",
    label: "Claude",
    // Claude runs as Claude Code sessions, any number at once; kept here for legacy message labels.
    locked: false,
    models: [
      { id: "default", label: "Claude (CLI default)" },
      { id: "opus", label: "Claude Opus" },
      { id: "sonnet", label: "Claude Sonnet" },
      { id: "haiku", label: "Claude Haiku" },
    ],
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    locked: false,
    models: [
      { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite · fastest", freeDailyEstimate: 1000 },
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", freeDailyEstimate: 250 },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", freeDailyEstimate: 250 },
      { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", freeDailyEstimate: 1000 },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (paid)", freeDailyEstimate: 0 },
    ],
  },
  groq: {
    id: "groq",
    label: "Groq",
    locked: false,
    models: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
      { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B Instant" },
      { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
      { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B" },
    ],
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    locked: false,
    models: [
      { id: "deepseek-flash", label: "DeepSeek V4.1 Flash · fastest" },
      { id: "deepseek-flash-vision", label: "DeepSeek V4.1 Flash · Vision" },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    ],
  },
  // Models below are starting points; adding a key fills in the provider's full list (see modelList).
  openai: { id: "openai", label: "OpenAI", locked: false, models: [{ id: "gpt-5", label: "GPT-5" }, { id: "gpt-5-mini", label: "GPT-5 mini" }] },
  openrouter: { id: "openrouter", label: "OpenRouter", locked: false, models: [{ id: "openrouter/auto", label: "OpenRouter · Auto" }] },
  xai: { id: "xai", label: "xAI Grok", locked: false, models: [{ id: "grok-4", label: "Grok 4" }] },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    locked: false,
    models: [
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
    ],
  },
  mistral: { id: "mistral", label: "Mistral", locked: false, models: [{ id: "mistral-large-latest", label: "Mistral Large" }, { id: "mistral-small-latest", label: "Mistral Small" }] },
  ollama: { id: "ollama", label: "Local (Ollama)", locked: false, models: [] },
  custom: { id: "custom", label: "Custom server", locked: false, models: [] },
};

/** Providers an AI chat can use. Claude is used through Claude Code sessions instead. */
export const PROVIDER_ORDER: ProviderId[] = ["deepseek", "openai", "anthropic", "gemini", "openrouter", "xai", "mistral", "groq", "ollama", "custom"];
export const KEYED_PROVIDERS: KeyedProviderId[] = ["deepseek", "openai", "anthropic", "gemini", "openrouter", "xai", "mistral", "groq", "ollama", "custom"];

/** Where each OpenAI-style provider lives (chat completions; its model list is at …/models). */
export const PROVIDER_BASE: Partial<Record<KeyedProviderId, string>> = {
  deepseek: "https://api.deepseek.com",
  groq: "https://api.groq.com/openai/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  xai: "https://api.x.ai/v1",
  anthropic: "https://api.anthropic.com/v1",
  mistral: "https://api.mistral.ai/v1",
  ollama: "http://localhost:11434/v1",
};

/** Where to sign up for a key, shown next to each provider. */
export const KEY_PAGES: Partial<Record<KeyedProviderId, string>> = {
  deepseek: "https://platform.deepseek.com/api_keys",
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  gemini: "https://aistudio.google.com/apikey",
  openrouter: "https://openrouter.ai/keys",
  xai: "https://console.x.ai",
  mistral: "https://console.mistral.ai/api-keys",
  groq: "https://console.groq.com/keys",
};

export const GEMINI_FLASH: ModelRef = { provider: "gemini", model: "gemini-3.5-flash" };
export const DEEPSEEK_FLASH: ModelRef = { provider: "deepseek", model: "deepseek-flash" };
export const GROQ_FAST: ModelRef = { provider: "groq", model: "llama-3.3-70b-versatile" };

/** Gemini 2.5 models are closed to new API users; saved chats move to their successors. */
const RETIRED_GEMINI: Record<string, string> = {
  "gemini-2.5-flash": "gemini-3.5-flash",
  "gemini-2.5-flash-lite": "gemini-3.5-flash-lite",
  "gemini-2.5-pro": "gemini-3.5-flash",
};

/** DeepSeek's discontinued model names (shut down 2026-07-24) move to the current models. */
const RETIRED_DEEPSEEK: Record<string, string> = {
  "deepseek-chat": "deepseek-flash",
  "deepseek-reasoner": "deepseek-v4-pro",
  "deepseek-v4-flash": "deepseek-flash",
};

/**
 * Maps a persisted model onto one this build can run: unknown providers and retired Gemini models
 * are replaced so old chats and settings keep working.
 */
export function upgradeModel(ref: { provider: string; model: string } | undefined, fallback: ModelRef): ModelRef {
  if (!ref || !(ref.provider in PROVIDERS)) return fallback;
  if (ref.provider === "gemini" && RETIRED_GEMINI[ref.model]) return { provider: "gemini", model: RETIRED_GEMINI[ref.model] };
  if (ref.provider === "deepseek" && RETIRED_DEEPSEEK[ref.model]) return { provider: "deepseek", model: RETIRED_DEEPSEEK[ref.model] };
  return ref as ModelRef;
}

export function isLockedProvider(provider: ProviderId): boolean {
  return PROVIDERS[provider].locked;
}

export function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.provider === b.provider && a.model === b.model;
}

export function modelsFor(provider: ProviderId, settings: Settings): ModelInfo[] {
  const custom = provider === "claude" ? settings.claude.customModels : settings.providers[provider].customModels;
  const builtIn = PROVIDERS[provider].models;
  const extra = custom
    .map((id) => id.trim())
    .filter((id) => id && !builtIn.some((m) => m.id === id))
    .map((id) => ({ id, label: id }));
  return [...builtIn, ...extra];
}

export function modelLabel(ref: ModelRef): string {
  return PROVIDERS[ref.provider].models.find((m) => m.id === ref.model)?.label ?? ref.model;
}

/** E.V-only model ids that are another model with extra abilities; DeepSeek gets the real name. */
const API_MODEL: Record<string, string> = { "deepseek-flash-vision": "deepseek-flash" };

export function apiModel(model: string): string {
  return API_MODEL[model] ?? model;
}

/** OpenAI-format models E.V sends pictures to. */
export function seesImages(model: string): boolean {
  return model === "deepseek-flash-vision";
}

/** Models with a thinking switch. */
export function canThink(ref: ModelRef): boolean {
  return ref.provider === "deepseek";
}

export function freeDailyEstimate(provider: KeyedProviderId, model: string): number | undefined {
  return PROVIDERS[provider].models.find((m) => m.id === model)?.freeDailyEstimate;
}

/** Unlocked fallback for a chat that cannot use its model: DeepSeek, else Gemini Flash, else Groq. */
export function pickFallback(settings: Settings): ModelRef {
  if (settings.providers.deepseek.keys.length > 0) return DEEPSEEK_FLASH;
  if (settings.providers.gemini.keys.length > 0) return GEMINI_FLASH;
  if (settings.providers.groq.keys.length > 0) return GROQ_FAST;
  // Any other provider with a key (or a local model): its first model.
  for (const provider of KEYED_PROVIDERS) {
    const models = modelsFor(provider, settings);
    if (settings.providers[provider]?.keys.length && models.length) return { provider, model: models[0].id };
  }
  return DEEPSEEK_FLASH;
}
