import { create } from "zustand";
import { loadSettingsFile, saveSettingsFile } from "../lib/ipc";
import { uid } from "../lib/ids";
import { DEEPSEEK_FLASH, KEYED_PROVIDERS, PROVIDERS, upgradeModel } from "../providers/catalog";
import { keyEngine } from "../providers/keyPool";
import type { ApiKey, KeyedProviderId, Settings } from "../types";

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  providers: {
    gemini: { keys: [], customModels: [], dailyLimits: {} },
    groq: { keys: [], customModels: [], dailyLimits: {} },
    deepseek: { keys: [], customModels: [], dailyLimits: {} },
    openai: { keys: [], customModels: [], dailyLimits: {} },
    openrouter: { keys: [], customModels: [], dailyLimits: {} },
    xai: { keys: [], customModels: [], dailyLimits: {} },
    anthropic: { keys: [], customModels: [], dailyLimits: {} },
    mistral: { keys: [], customModels: [], dailyLimits: {} },
    ollama: { keys: [], customModels: [], dailyLimits: {} },
    custom: { keys: [], customModels: [], dailyLimits: {} },
  },
  claude: { cwd: "", customModels: [] },
  voice: {
    ttsVoice: "gideon-a",
    ttsRate: 185,
    sttModelPath: "~/.whisper-cpp/models/ggml-base.en.bin",
    sttLanguage: "auto",
    wakeWord: true,
    replies: { typed: "silent", tasksOverMusic: "notch", important: "speak" },
    conversationSeconds: 8,
    followUps: "always",
    windowV2: true,
    replyGateDb: 10,
    echoCancellation: false,
    turbo: false,
    turboVoice: "Despina",
    turboModel: "gemini-3.1-flash-live-preview",
    holdToTalk: { enabled: false, shortcut: "control+option+space", speak: true },
    dictionary: [],
    dictation: { enabled: true, shortcut: "rightoption", polished: false, doubleCommand: true, trailingSpace: true, v2: true },
  },
  approvalKeys: { approve: "control+option+a", always: "control+option+s", cancel: "control+option+d" },
  panel: { shortcut: "option+space", chatId: null },
  router: { enabled: true },
  notch: { mode: "ev", chatPanels: true, lyrics: "keep", caffeine: { lid: false, batteryLimit: 0, minutes: 0 },
    hideInFullscreen: true,
    features: { chat: true, music: true, shelf: true, dictation: true, caffeine: true },
    clipboard: { enabled: true, shortcut: "shift+command+c", limit: 100, ignoreApps: ["1Password", "Bitwarden", "Keychain Access", "Passwords", "Dashlane", "LastPass"] },
  },
  background: { keepNotchOnQuit: true, openAtLogin: false },
  browsers: { preferred: null, notUsing: [], known: {} },
  spending: { dailyLimit: 0 },
  customServer: { baseUrl: "" },
  agents: { claude: true, codex: false },
  topBarStyle: "full",
  topBarShow: "always",
  onboarded: false,
  screenPicture: "ask",
  defaultModel: DEEPSEEK_FLASH,
  systemPrompt: "",
  terminal: { fontSize: 13, presets: [], resumeClaude: true },
  recentFolders: [],
  reminders: { leadMinutes: 10 },
};

const MAX_RECENT_FOLDERS = 12;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Default display name for the n-th key of a provider, e.g. "Gemini 3". */
export function defaultKeyName(provider: KeyedProviderId, n: number): string {
  return `${PROVIDERS[provider].label} ${n}`;
}

/** Accepts both the current `{ id, name, key }` shape and the older bare-string key lists. */
function apiKeys(provider: KeyedProviderId, value: unknown): ApiKey[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const keys: ApiKey[] = [];
  for (const entry of value) {
    const raw = typeof entry === "string" ? { key: entry } : (entry as Partial<ApiKey> | null);
    const key = typeof raw?.key === "string" ? raw.key.trim() : "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push({
      id: typeof raw?.id === "string" && raw.id ? raw.id : uid("key-"),
      name: typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim() : defaultKeyName(provider, keys.length + 1),
      key,
    });
  }
  return keys;
}

function limits(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] > 0,
    ),
  );
}

/** Merges a persisted (possibly older or partial) settings object onto the defaults. */
function normalize(raw: unknown): Settings {
  const input = (raw ?? {}) as Partial<Settings>;
  const settings = structuredClone(DEFAULT_SETTINGS);
  for (const id of KEYED_PROVIDERS) {
    const p = input.providers?.[id];
    settings.providers[id] = {
      keys: apiKeys(id, p?.keys),
      customModels: strings(p?.customModels),
      dailyLimits: limits(p?.dailyLimits),
    };
  }
  settings.claude = {
    cwd: typeof input.claude?.cwd === "string" ? input.claude.cwd : "",
    customModels: strings(input.claude?.customModels),
  };
  settings.voice = { ...settings.voice, ...(input.voice ?? {}) };
  settings.voice.holdToTalk = { ...DEFAULT_SETTINGS.voice.holdToTalk, ...(input.voice?.holdToTalk ?? {}) };
  settings.voice.dictionary = strings(input.voice?.dictionary).map((w) => w.trim()).filter(Boolean).slice(0, 500);
  settings.voice.dictation = { ...DEFAULT_SETTINGS.voice.dictation, ...(input.voice?.dictation ?? {}) };
  // Once: Polished off (it added a second or more and sometimes extra words); it stays opt-in.
  if (!settings.voice.dictation.v2) settings.voice.dictation = { ...settings.voice.dictation, polished: false, trailingSpace: true, v2: true };
  const replies = (input.voice as { replies?: Partial<Settings["voice"]["replies"]> } | undefined)?.replies ?? {};
  settings.voice.replies = {
    typed: replies.typed === "speak" ? "speak" : "silent",
    tasksOverMusic: replies.tasksOverMusic === "speak" ? "speak" : "notch",
    important: replies.important === "notch" ? "notch" : "speak",
  };
  if (!["asked", "never", "always"].includes(settings.voice.followUps)) settings.voice.followUps = "always";
  // Once: the conversation window after every answer (8 s), so several requests in a row need one "Hey E.V".
  if (!settings.voice.windowV2) {
    settings.voice.followUps = "always";
    settings.voice.conversationSeconds = 8;
    settings.voice.windowV2 = true;
  }
  const seconds = Number(settings.voice.conversationSeconds);
  settings.voice.conversationSeconds = Number.isFinite(seconds) ? Math.min(15, Math.max(2, Math.round(seconds))) : 8;
  if (typeof settings.voice.replyGateDb !== "number" || !Number.isFinite(settings.voice.replyGateDb)) settings.voice.replyGateDb = 10;
  settings.approvalKeys = { ...DEFAULT_SETTINGS.approvalKeys, ...(input.approvalKeys ?? {}) };
  settings.panel = { ...DEFAULT_SETTINGS.panel, ...(input.panel ?? {}) };
  settings.router = { enabled: (input.router as Partial<Settings["router"]> | undefined)?.enabled !== false };
  const notch = (input.notch ?? {}) as Partial<Settings["notch"]>;
  const caffeine = (notch.caffeine ?? {}) as Partial<Settings["notch"]["caffeine"]>;
  const whole = (n: unknown, max: number) => (typeof n === "number" && n >= 0 ? Math.min(Math.round(n), max) : 0);
  settings.notch = {
    mode: notch.mode === "vorssaint" || notch.mode === "off" ? notch.mode : "ev",
    chatPanels: notch.chatPanels !== false,
    lyrics: notch.lyrics === "never" ? "never" : "keep",
    caffeine: { lid: caffeine.lid === true, batteryLimit: whole(caffeine.batteryLimit, 95), minutes: whole(caffeine.minutes, 24 * 60) },
    hideInFullscreen: notch.hideInFullscreen !== false,
    features: normalizeFeatures(notch.features),
    clipboard: normalizeClipboard(notch.clipboard),
  };
  const background = (input.background ?? {}) as Partial<Settings["background"]>;
  settings.background = { keepNotchOnQuit: background.keepNotchOnQuit !== false, openAtLogin: background.openAtLogin === true };
  settings.browsers = normalizeBrowsers(input.browsers);
  const limit = Number(input.spending?.dailyLimit);
  settings.spending = { dailyLimit: Number.isFinite(limit) && limit > 0 ? limit : 0 };
  settings.customServer = { baseUrl: typeof input.customServer?.baseUrl === "string" ? input.customServer.baseUrl : "" };
  settings.agents = { claude: input.agents?.claude !== false, codex: input.agents?.codex === true };
  settings.onboarded = input.onboarded === true;
  if (typeof input.onboardStart === "number") settings.onboardStart = Math.max(0, Math.min(8, Math.round(input.onboardStart)));
  if (input.movedFromPersonal === true) settings.movedFromPersonal = true;
  // 1.0.2 had one setting ("always" | "auto" | "compact"); it splits into style and showing.
  const old = (input as { topBar?: string }).topBar;
  settings.topBarStyle = input.topBarStyle === "compact" || (!input.topBarStyle && old === "compact") ? "compact" : "full";
  settings.topBarShow = input.topBarShow === "hover" || (!input.topBarShow && old === "auto") ? "hover" : "always";
  if (!["ask", "vision", "text"].includes(settings.screenPicture)) settings.screenPicture = "ask";
  // "System default" from before E.V had its own voice becomes E.V's voice.
  if (!settings.voice.ttsVoice) settings.voice.ttsVoice = DEFAULT_SETTINGS.voice.ttsVoice;
  if (input.defaultModel?.provider && input.defaultModel.model) {
    const model = upgradeModel(input.defaultModel, DEEPSEEK_FLASH);
    // Claude now runs as Claude Code sessions; AI chats default to an API model.
    settings.defaultModel = model.provider === "claude" ? DEEPSEEK_FLASH : model;
  }
  if (typeof input.systemPrompt === "string") settings.systemPrompt = input.systemPrompt;
  const terminal = (input.terminal ?? {}) as Partial<Settings["terminal"]>;
  settings.terminal = {
    fontSize: typeof terminal.fontSize === "number" ? Math.min(24, Math.max(9, terminal.fontSize)) : 13,
    presets: Array.isArray(terminal.presets)
      ? terminal.presets
          .filter((p) => p && typeof p.name === "string" && typeof p.command === "string" && p.command.trim())
          .map((p) => ({ id: p.id || uid("preset-"), name: p.name.trim() || p.command, command: p.command, cwd: p.cwd || undefined }))
      : [],
    resumeClaude: terminal.resumeClaude !== false,
  };
  settings.recentFolders = strings(input.recentFolders).slice(0, MAX_RECENT_FOLDERS);
  const lead = (input.reminders as Partial<Settings["reminders"]> | undefined)?.leadMinutes;
  settings.reminders = { leadMinutes: typeof lead === "number" && lead >= 0 ? Math.min(lead, 24 * 60) : 10 };
  return settings;
}

function syncKeyEngine(settings: Settings): void {
  for (const id of KEYED_PROVIDERS) {
    keyEngine.configure(id, settings.providers[id].keys, settings.providers[id].dailyLimits);
  }
}

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  loadError: string | null;
  load: () => Promise<void>;
  save: (next: Settings) => Promise<void>;
  /** Moves a folder to the top of the recent list (and saves). */
  rememberFolder: (path: string) => void;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  loadError: null,
  load: async () => {
    try {
      const raw = await loadSettingsFile();
      const settings = normalize(raw);
      syncKeyEngine(settings);
      set({ settings, loaded: true });
      // Rewrite older files once (bare-string keys, removed providers) so ids and names stick.
      if (raw && JSON.stringify(raw) !== JSON.stringify(settings)) void saveSettingsFile(settings).catch(() => {});
    } catch (err) {
      syncKeyEngine(DEFAULT_SETTINGS);
      set({ loaded: true, loadError: String(err) });
    }
  },
  save: async (next) => {
    const settings = normalize(next);
    syncKeyEngine(settings);
    set({ settings });
    await saveSettingsFile(settings);
  },
  rememberFolder: (path) => {
    const current = get().settings;
    if (!path || current.recentFolders[0] === path) return;
    const recentFolders = [path, ...current.recentFolders.filter((f) => f !== path)].slice(0, MAX_RECENT_FOLDERS);
    void get().save({ ...current, recentFolders }).catch(() => {});
  },
}));

const ROUTES = ["script", "extension", "accessibility"];

export function normalizeBrowsers(input: unknown): Settings["browsers"] {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<Settings["browsers"]>;
  const known: Settings["browsers"]["known"] = {};
  for (const [name, value] of Object.entries(raw.known && typeof raw.known === "object" ? raw.known : {})) {
    const v = value as Partial<Settings["browsers"]["known"][string]>;
    if (!name.trim() || !v || typeof v !== "object") continue;
    known[name] = {
      engine: typeof v.engine === "string" ? v.engine : "unknown",
      route: typeof v.route === "string" && ROUTES.includes(v.route) ? v.route : "accessibility",
      ...(v.switch === "on" || v.switch === "off" || v.switch === "declined" ? { switch: v.switch } : {}),
      ...(v.extension === true ? { extension: true } : {}),
      checkedAt: typeof v.checkedAt === "number" ? v.checkedAt : 0,
    };
  }
  const names = (list: unknown) => (Array.isArray(list) ? [...new Set(list.filter((n): n is string => typeof n === "string" && n.trim().length > 0))] : []);
  return { preferred: typeof raw.preferred === "string" && raw.preferred.trim() ? raw.preferred.trim() : null, notUsing: names(raw.notUsing), known };
}

export function normalizeFeatures(input: unknown): Settings["notch"]["features"] {
  const f = (input ?? {}) as Partial<Settings["notch"]["features"]>;
  return { chat: f.chat !== false, music: f.music !== false, shelf: f.shelf !== false, dictation: f.dictation !== false, caffeine: f.caffeine !== false };
}

export function normalizeClipboard(input: unknown): Settings["notch"]["clipboard"] {
  const d = DEFAULT_SETTINGS.notch.clipboard;
  const c = (input ?? {}) as Partial<Settings["notch"]["clipboard"]>;
  const limit = Number(c.limit);
  return {
    enabled: c.enabled !== false,
    shortcut: typeof c.shortcut === "string" ? c.shortcut : d.shortcut,
    limit: Number.isFinite(limit) && limit >= 10 ? Math.min(Math.round(limit), 1000) : d.limit,
    ignoreApps: Array.isArray(c.ignoreApps) ? c.ignoreApps.filter((a): a is string => typeof a === "string" && a.trim() !== "") : [...d.ignoreApps],
  };
}
