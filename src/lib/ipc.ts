import { Channel, invoke } from "@tauri-apps/api/core";
import { HttpStatusError } from "../providers/limits";

export class AbortedError extends Error {
  constructor() {
    super("Generation stopped");
    this.name = "AbortedError";
  }
}

interface ProviderErrorPayload {
  status: number;
  message: string;
  headers?: Record<string, string>;
}

function isProviderError(value: unknown): value is ProviderErrorPayload {
  return typeof value === "object" && value !== null && "status" in value && "message" in value;
}

/** Wires an AbortSignal to a backend cancel command for the lifetime of `run`. */
async function withCancel<T>(signal: AbortSignal, cancel: () => Promise<unknown>, run: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new AbortedError();
  const onAbort = () => void cancel();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await run();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function providerStream(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  onChunk: (text: string) => void,
  signal: AbortSignal,
): Promise<Record<string, string>> {
  const requestId = crypto.randomUUID();
  const channel = new Channel<string>();
  channel.onmessage = onChunk;
  try {
    const response = await withCancel(
      signal,
      () => invoke("provider_cancel", { requestId }),
      () =>
        invoke<{ headers: Record<string, string> }>("provider_stream", {
          request: { requestId, url, headers, body: JSON.stringify(body) },
          onChunk: channel,
        }),
    );
    return response.headers;
  } catch (err) {
    if (signal.aborted) throw new AbortedError();
    if (isProviderError(err)) {
      if (err.status === 0) throw new Error(err.message);
      throw new HttpStatusError(err.status, extractErrorMessage(err), err.message, err.headers ?? {});
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function extractErrorMessage(err: ProviderErrorPayload): string {
  try {
    const parsed = JSON.parse(err.message);
    const inner = Array.isArray(parsed) ? parsed[0] : parsed;
    const message = inner?.error?.message ?? inner?.message;
    if (typeof message === "string") return err.status ? `HTTP ${err.status}: ${message}` : message;
  } catch {
    /* body was not JSON */
  }
  const text = err.message.trim().slice(0, 400) || "request failed";
  return err.status ? `HTTP ${err.status}: ${text}` : text;
}

export interface ClaudeStatus {
  available: boolean;
  path: string | null;
  version: string | null;
}

export const claudeStatus = () => invoke<ClaudeStatus>("claude_status");

export interface UsageWindow {
  /** Percent of the window already used (0–100). */
  utilization: number;
  resetsAt: string | null;
}

export interface ClaudeUsage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
}

export const claudeUsage = () => invoke<ClaudeUsage>("claude_usage");

export const loadSettingsFile = () => invoke<unknown | null>("load_settings");
export const saveSettingsFile = (settings: unknown) => invoke<void>("save_settings", { settings });

export const ttsSynthesize = (text: string, voice: string, rate: number) =>
  invoke<ArrayBuffer>("tts_synthesize", { text, voice: voice && voice !== "system" ? voice : null, rate: rate || null });

export interface Voice {
  name: string;
  locale: string;
}
export const ttsVoices = () => invoke<Voice[]>("tts_voices");

export interface SttStatus {
  /** "parakeet" = on-device engine kept loaded; "whisper-cli" = fallback. */
  engine: "parakeet" | "whisper-cli";
  binary: string | null;
  modelExists: boolean;
  modelPath: string;
}
export const sttStatus = (modelPath: string) => invoke<SttStatus>("stt_status", { modelPath });

export const sttTranscribe = (wav: Uint8Array, modelPath: string, language: string) =>
  invoke<string>("stt_transcribe", wav, {
    headers: {
      "x-model-path": encodeURIComponent(modelPath),
      "x-language": encodeURIComponent(language || "auto"),
    },
  });

/**
 * One 16 kHz mic frame plus what E.V was playing at the time: the engine removes E.V's own
 * voice (WebRTC echo cancellation) and Silero says whether someone is speaking.
 */
export async function voiceFrame(mic: Float32Array, playing: Float32Array): Promise<{ speech: boolean; clean: Float32Array }> {
  const body = new Uint8Array(4 + mic.length * 8);
  const view = new DataView(body.buffer);
  view.setUint32(0, mic.length, true);
  body.set(new Uint8Array(mic.buffer, mic.byteOffset, mic.byteLength), 4);
  const ref = playing.length === mic.length ? playing : Float32Array.from({ length: mic.length }, (_, i) => playing[i] ?? 0);
  body.set(new Uint8Array(ref.buffer, ref.byteOffset, ref.byteLength), 4 + mic.length * 4);
  const reply = new Uint8Array(await invoke<ArrayBuffer>("voice_frame_cmd", body));
  return { speech: reply[0] === 1, clean: new Float32Array(reply.slice(4).buffer) };
}
export const vadReset = () => invoke<void>("vad_reset");

export interface VoiceModel {
  id: "vad" | "stt" | "tts";
  label: string;
  installed: boolean;
  bytes: number;
}
export interface VoiceEngineStatus {
  models: VoiceModel[];
  voices: { id: string; label: string }[];
  downloading: boolean;
}
export interface VoiceModelProgress {
  id: VoiceModel["id"];
  stage: "downloading" | "checking" | "installed" | "failed";
  done: number;
  total: number;
  error: string | null;
}
export const voiceEngineStatus = () => invoke<VoiceEngineStatus>("voice_engine_status");
export const voiceEngineWarm = () => invoke<void>("voice_engine_warm");
export const voiceModelsDownload = () => invoke<void>("voice_models_download");

export interface LiveConfig {
  key: string;
  model: string;
  voice: string;
  system: string;
}
export type LiveEvent = { kind: "audio"; data: string } | { kind: "text"; text: string } | { kind: "handoff" } | { kind: "done" };
export const livePrepare = (config: LiveConfig) => invoke<void>("live_prepare", { config });
export const liveCancel = () => invoke<void>("live_cancel");
export function liveTurn(config: LiveConfig, history: { role: string; text: string }[], text: string, onEvent: (e: LiveEvent) => void): Promise<void> {
  const channel = new Channel<LiveEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("live_turn", { config, history, text, onEvent: channel });
}

export interface ConnectionInfo {
  id: string;
  name: string;
  description: string;
  account: string | null;
  setupUrl: string | null;
  source: string;
  secrets: { env: string; label: string; saved: boolean }[];
  runnable: boolean;
  running: boolean;
}
export interface ConnectionTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  destructive: boolean;
}
export const connectionsCatalog = () => invoke<ConnectionInfo[]>("connections_catalog");
export const connectionStart = (id: string) => invoke<ConnectionTool[]>("connection_start", { id });
export const connectionStop = (id: string) => invoke<void>("connection_stop", { id });
export const connectionCall = (id: string, tool: string, args: Record<string, unknown>) =>
  invoke<{ text: string; images: string[]; error: boolean }>("connection_call", { id, tool, args });
export const connectionSetSecret = (id: string, env: string, value: string) => invoke<void>("connection_set_secret", { id, env, value });
export const connectionForgetSecrets = (id: string) => invoke<void>("connection_forget_secrets", { id });

export const openExternal = (url: string) => invoke<void>("open_external", { url });

export const attachmentSave = (bytes: Uint8Array, name: string) =>
  invoke<string>("attachment_save", bytes, { headers: { "x-name": encodeURIComponent(name) } });
export const attachmentRead = (path: string) => invoke<ArrayBuffer>("attachment_read", { path });
export const attachmentOpen = (path: string) => invoke<void>("attachment_open", { path });
export const attachmentDelete = (paths: string[]) => invoke<void>("attachment_delete", { paths });
export const attachmentRoot = () => invoke<string>("attachment_root");
/** Bytes of a file dragged in from Finder (the user chose it by dropping it). */
export const readDroppedFile = (path: string) => invoke<ArrayBuffer>("read_dropped_file", { path });

// ── Terminals ────────────────────────────────────────────────────────────────

export type PtyKind = "claude" | "shell" | "command";
export type PtyEvent = { type: "output"; data: string } | { type: "exit"; code: number };

export interface PtySpawn {
  id: string;
  kind: PtyKind;
  cwd: string;
  command?: string;
  claudeArgs?: string[];
  cols: number;
  rows: number;
}

/** Starts a terminal; resolves once the process is running and streams events to `onEvent`. */
export function ptySpawn(request: PtySpawn, onEvent: (event: PtyEvent) => void): Promise<void> {
  const channel = new Channel<PtyEvent>();
  channel.onmessage = onEvent;
  return invoke("pty_spawn", { request, onEvent: channel });
}
export const ptyWrite = (id: string, data: string) => invoke<void>("pty_write", { id, data });
export const ptyResize = (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows });
export const ptySignal = (id: string, signal: "INT" | "TERM" | "KILL") => invoke<boolean>("pty_signal", { id, signal });
export const ptyKill = (id: string) => invoke<void>("pty_kill", { id });
/** Sessions tmux kept running while E.V was closed. */
export const ptyAlive = () => invoke<string[]>("pty_alive");
export const ptyLog = (id: string) => invoke<string>("pty_log", { id });

export interface PtyStats {
  id: string;
  running: boolean;
  exitCode: number | null;
  foreground: string;
  cpu: number;
  memoryMb: number;
  processes: number;
  title: string;
}
export const ptyStats = () => invoke<PtyStats[]>("pty_stats");

// ── Folders, Claude sessions, skills ─────────────────────────────────────────

export const pickFolder = (defaultPath?: string) => invoke<string | null>("pick_folder", { defaultPath: defaultPath ?? null });
export const pickSavePath = (defaultName: string) => invoke<string | null>("pick_save_path", { defaultName });
export const saveTextFile = (path: string, contents: string) => invoke<void>("save_text_file", { path, contents });

export interface ClaudeSessionInfo {
  id: string;
  title: string;
  /** Epoch seconds. */
  modified: number;
  size: number;
}
export const claudeSessions = (cwd: string) => invoke<ClaudeSessionInfo[]>("claude_sessions", { cwd });
export const claudeLatestSession = (cwd: string, since: number, exclude: string[]) =>
  invoke<string | null>("claude_latest_session", { cwd, since, exclude });

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  claudeOnly: boolean;
}

export interface AgentContext {
  globalRules: string | null;
  projectRules: string | null;
  summary: string | null;
  skills: SkillInfo[];
  cwd: string;
  home: string;
}
export const agentContext = (cwd: string) => invoke<AgentContext>("agent_context", { cwd });

export interface SkillContent {
  name: string;
  path: string;
  content: string;
  files: string[];
  claudeOnly: boolean;
}
export const loadSkill = (name: string) => invoke<SkillContent>("load_skill", { name });

// ── Agent actions (only invoked after the user approves) ─────────────────────

export interface FileText {
  path: string;
  exists: boolean;
  content: string;
  totalLines: number;
}
export const toolReadFile = (cwd: string, path: string, offset?: number, limit?: number) =>
  invoke<FileText>("tool_read_file", { cwd, path, offset: offset ?? null, limit: limit ?? null });
export const toolWriteFile = (cwd: string, path: string, content: string) => invoke<string>("tool_write_file", { cwd, path, content });
export const toolEditFile = (cwd: string, path: string, oldString: string, newString: string, replaceAll?: boolean) =>
  invoke<string>("tool_edit_file", { cwd, path, oldString, newString, replaceAll: replaceAll ?? null });
export const toolListDirectory = (cwd: string, path: string) => invoke<string>("tool_list_directory", { cwd, path });
export const toolFindFiles = (cwd: string, pattern: string, path?: string, everywhere?: boolean) =>
  invoke<string>("tool_find_files", { cwd, pattern, path: path ?? null, everywhere: everywhere ?? null });
export const toolSearchFiles = (cwd: string, pattern: string, path?: string, glob?: string) =>
  invoke<string>("tool_search_files", { cwd, pattern, path: path ?? null, glob: glob ?? null });

export interface CommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}
export const toolRunCommand = (cwd: string, command: string, taskId: string, timeoutSeconds?: number) =>
  invoke<CommandResult>("tool_run_command", { cwd, command, taskId, timeoutSeconds: timeoutSeconds ?? null });
export const liveFetchJson = (url: string) => invoke<string>("live_fetch_json", { url });
export const toolWebSearch = (query: string) => invoke<string>("tool_web_search", { query });
export const toolWebFetch = (url: string) => invoke<string>("tool_web_fetch", { url });
export const toolCancel = (taskId: string) => invoke<boolean>("tool_cancel", { taskId });

export interface DocPage {
  /** 1-based page or slide number; 0 for a picture found inside an Office file. */
  number: number;
  text: string;
  /** Words recognized in the page's picture. */
  ocr: string;
  /** JPEG, base64 (empty when pictures weren't asked for). */
  image: string;
  /** Share of the page left empty at the bottom (0–1; measured only with a picture). */
  blank: number;
}
export interface DocRead {
  path: string;
  kind: "pdf" | "image" | "word" | "slides" | "sheet";
  pageCount: number;
  pages: DocPage[];
  text: string;
  note: string;
}
export const toolReadDocument = (cwd: string, path: string, pages?: string, pictures = true) =>
  invoke<DocRead>("tool_read_document", { cwd, path, pages: pages ?? null, pictures });
export interface MadeDocument {
  path: string;
  bytes: number;
  previewPdf: string;
  /** Share of the text printed under 7pt. */
  smallText: number;
  /** Text that spills out of its table cell or box (start of each). */
  overflow: string[];
}
export const toolMakeDocument = (cwd: string, path: string, format: string, html: string, landscape?: boolean, paper?: string) =>
  invoke<MadeDocument>("tool_make_document", { cwd, path, format, html, landscape: landscape ?? null, paper: paper ?? null });
export const toolDiscardPreview = (path: string) => invoke<void>("tool_discard_preview", { path });

export interface BgStatus {
  id: string;
  command: string;
  cwd: string;
  running: boolean;
  exitCode: number | null;
  seconds: number;
  output: string;
  skipped: number;
}
export const toolBgStart = (cwd: string, command: string) => invoke<string>("tool_bg_start", { cwd, command });
export const toolBgRead = (id: string, waitSeconds?: number) => invoke<BgStatus>("tool_bg_read", { id, waitSeconds: waitSeconds ?? null });
export const toolBgStop = (id: string) => invoke<BgStatus>("tool_bg_stop", { id });
export const toolBgList = () => invoke<{ id: string; command: string; running: boolean; seconds: number }[]>("tool_bg_list");

// ── Vorssaint notch link ──────────────────────────────────────────────────────

export const controlMeta = (
  sessions: Record<string, Record<string, unknown>>,
  presets: Record<string, unknown>[],
  recent: string[],
  windowVisible: boolean,
) => invoke<void>("control_meta", { sessions, presets, recent, windowVisible });
export const controlCreated = (reference: string, id: string) => invoke<void>("control_created", { reference, id });

export const passphraseStatus = () => invoke<boolean>("passphrase_status");
export const passphraseSet = (phrase: string) => invoke<void>("passphrase_set", { phrase });
export const passphraseClear = () => invoke<void>("passphrase_clear");
export const passphraseCheck = (heard: string) => invoke<boolean>("passphrase_check", { heard });
export const passphraseMatches = (heard: string, phrase: string) => invoke<boolean>("passphrase_matches", { heard, phrase });

export const vaultLoad = () => invoke<string>("vault_load");
export const vaultSave = (json: string) => invoke<void>("vault_save", { json });
export const showNotification = (title: string, body: string) => invoke<void>("show_notification", { title, body });

// ── Mac control ───────────────────────────────────────────────────────────────

export interface MacControl {
  id: number;
  role: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  focused: boolean;
  /** Links: where they go. */
  url?: string;
  /** Off screen: "below", "above", "left" or "right" (clicking it scrolls it into view first). */
  place?: string;
}
export interface MacLook {
  app: string;
  window: string;
  frame: [number, number, number, number];
  image: string;
  controls: MacControl[];
  note: string;
}
export interface MacActionResult {
  verdict: "ok" | "final" | "never";
  done: boolean;
  target: string;
  x?: number | null;
  y?: number | null;
  mode: "background" | "background-shortcut" | "screen" | "";
  needsScreen: boolean;
  /** What the window showed afterwards: true changed, false nothing changed, null/absent not checked. */
  changed?: boolean | null;
  /** The change in words: new controls with their current numbers, a sheet, or "nothing changed". */
  report?: string;
}
export interface MacSystemState {
  volume?: number | null;
  muted?: boolean | null;
  darkMode?: boolean | null;
}

export const macPermissions = () => invoke<{ accessibility: boolean; screen: boolean }>("mac_permissions");
export const macRequestPermission = (kind: "accessibility" | "screen") => invoke<void>("mac_request_permission", { kind });
export const macLook = (app?: string, useScreen = false, picture = false) => invoke<MacLook>("mac_look", { app: app ?? null, useScreen, picture });
export const macFront = () => invoke<{ app: string; window: string; selected: string }>("mac_front");
export const macClick = (request: {
  app: string;
  id?: number;
  label?: string;
  role?: string;
  x?: number;
  y?: number;
  double?: boolean;
  right?: boolean;
  approved?: boolean;
  useScreen?: boolean;
}) => invoke<MacActionResult>("mac_click", { request });
export interface DragEnd {
  id?: number;
  label?: string;
  x?: number;
  y?: number;
}
export const macDrag = (app: string, from: DragEnd, to: DragEnd, right = false, useScreen = false) =>
  invoke<MacActionResult>("mac_drag", {
    request: { app, fromId: from.id, fromLabel: from.label, fromX: from.x, fromY: from.y, toId: to.id, toLabel: to.label, toX: to.x, toY: to.y, right, useScreen },
  });
export const macMenu = (app: string, path: string, approved = false) =>
  invoke<{ listing: string; action: MacActionResult | null }>("mac_menu", { app, path, approved });
export const macType = (text: string, app: string, useScreen = false) => invoke<MacActionResult>("mac_type", { text, app, useScreen });
export const macKey = (key: string, modifiers: string[], approved: boolean, app: string, useScreen = false) =>
  invoke<MacActionResult>("mac_key", { key, modifiers, approved, app, useScreen });
/** "background" (the window scrolled, nothing else moved), "needs_screen" (it ignored that), or "screen". */
export const macScroll = (app: string, x: number | undefined, y: number | undefined, dx: number, dy: number, useScreen = false) =>
  invoke<"background" | "needs_screen" | "screen">("mac_scroll", { app, x: x ?? null, y: y ?? null, dx, dy, useScreen });
export const macUserIdle = () => invoke<number>("mac_user_idle");
export const macMedia = (key: string) => invoke<string>("mac_media", { key });
export const macScreen = () => invoke<string>("mac_screen");
export const macOpen = (target?: string, app?: string, background = false) => invoke<string>("mac_open", { target: target ?? null, app: app ?? null, background });
export const macApplescript = (script: string, javascript: boolean) => invoke<string>("mac_applescript", { script, javascript });
export const macShortcut = (name: string, input?: string) => invoke<string>("mac_shortcut", { name, input: input ?? null });
export const macQuit = (app: string) => invoke<string>("mac_quit", { app });
export const macClipboard = (write?: string) => invoke<string>("mac_clipboard", { write: write ?? null });
export const macSystem = (change: { volume?: number; muted?: boolean; darkMode?: boolean }) =>
  invoke<MacSystemState>("mac_system", { volume: change.volume ?? null, muted: change.muted ?? null, darkMode: change.darkMode ?? null });

// ── The E.V Browser (its own hidden Vivaldi) ──────────────────────────────

export interface PageView {
  url: string;
  title: string;
  /** Numbered controls plus the page's text, ready for the model. */
  text: string;
  controls: number;
  image: string;
}
export interface BrowserStep {
  do: "go" | "click" | "type" | "key" | "select" | "scroll" | "wait" | "back";
  id?: number;
  text?: string;
  key?: string;
  modifiers?: string[];
  value?: string;
  url?: string;
  clear?: boolean;
  submit?: boolean;
  ms?: number;
  dy?: number;
}
export interface BrowserStatus {
  installed: boolean;
  running: boolean;
  visible: boolean;
  signingIn: boolean;
  profile: string;
}
export const gbStatus = () => invoke<BrowserStatus>("gb_status");
export const gbOpen = (url: string, tab?: string, picture = false) => invoke<PageView>("gb_open", { url, tab: tab ?? null, picture });
export const gbLook = (tab?: string, picture = false) => invoke<PageView>("gb_look", { tab: tab ?? null, picture });
export const gbDo = (steps: BrowserStep[], tab?: string, picture = false) =>
  invoke<{ done: string[]; stopped: string | null; page: PageView }>("gb_do", { steps, tab: tab ?? null, picture });
export const gbShow = (visible: boolean, tab?: string) => invoke<void>("gb_show", { visible, tab: tab ?? null });
export const gbCloseTab = (tab: string) => invoke<void>("gb_close_tab", { tab });
export const gbDesmos = (expressions: string[], bounds?: [number, number, number, number]) => invoke<void>("gb_desmos", { expressions, bounds: bounds ?? null });
export const gbSignin = () => invoke<void>("gb_signin");
export const gbQuit = () => invoke<void>("gb_quit");
export interface BrowserTab {
  name: string;
  url: string;
  title: string;
  /** The user's own tab (private unless shared). */
  mine: boolean;
  shared: boolean;
}
export const gbTabs = () => invoke<BrowserTab[]>("gb_tabs");
export const gbNewTab = (url?: string) => invoke<string>("gb_new_tab", { url: url ?? null });
export const gbView = (tab: string, width: number, height: number, scale: number) => invoke<void>("gb_view", { tab, width, height, scale });
export const gbViewStop = () => invoke<void>("gb_view_stop");
export const gbMouse = (input: { kind: string; x: number; y: number; button?: string; clicks?: number; modifiers?: number; dx?: number; dy?: number }) =>
  invoke<void>("gb_mouse", { input });
export const gbKey = (input: { kind: string; key: string; code: string; keyCode: number; text?: string; modifiers?: number; commands?: string[] }) => invoke<void>("gb_key", { input });
export const gbInsertText = (text: string) => invoke<void>("gb_insert_text", { text });
export const gbNavigate = (action: "go" | "back" | "forward" | "reload", input?: string) => invoke<void>("gb_navigate", { action, input: input ?? null });
export const gbSelection = () => invoke<string>("gb_selection");
export const gbShare = (tab: string, shared: boolean) => invoke<void>("gb_share", { tab, shared });

// ── Safe-copy workspaces ─────────────────────────────────────────────────────

export interface WorkspaceChange {
  path: string;
  status: "added" | "modified" | "deleted";
}
export const workspaceClone = (project: string) => invoke<string>("workspace_clone", { project });
export const workspaceChanges = (project: string, shadow: string) => invoke<WorkspaceChange[]>("workspace_changes", { project, shadow });
export const workspaceApply = (project: string, shadow: string, paths: string[]) => invoke<number>("workspace_apply", { project, shadow, paths });
export const workspaceDiscard = (shadow: string) => invoke<void>("workspace_discard", { shadow });

export const pttConfigure = (enabled: boolean, shortcut: string) => invoke<void>("ptt_configure", { enabled, shortcut });
export const approvalKeysConfigure = (approve: string, always: string, cancel: string) => invoke<void>("approval_keys_configure", { approve, always, cancel });
export const approvalKeysActive = (on: boolean) => invoke<void>("approval_keys_active", { on });
/** Sends an approval to the Vorssaint notch; resolves with its answer (rejects "offline"). */
export const notchRequest = (id: string, request: Record<string, unknown>) =>
  invoke<"allow" | "always" | "deny" | "defer" | "withdrawn" | "closed">("notch_request", { id, request });
export const notchWithdraw = (id: string) => invoke<void>("notch_withdraw", { id });
/** One-way notch message; false when Vorssaint isn't running. */
export const notchMessage = (event: "listening" | "heard" | "say" | "waiting" | "clear", text: string, seconds?: number) =>
  invoke<boolean>("notch_message", { event, text, seconds: seconds ?? null });
/** Apps playing sound right now (E.V itself left out). */
export const audioPlaying = () => invoke<string[]>("audio_playing");
/** What the sound on the Mac is: music E.V can pause, a call it mustn't talk over, or sound it ignores. */
export type MediaNow = { music: string[]; calls: string[]; other: string[] };
export const mediaNow = () => invoke<MediaNow>("media_now");
/** Pauses that music; returns what was paused, for mediaResume. */
export const mediaPause = (music: string[]) => invoke<string[]>("media_pause", { music });
export const mediaResume = (paused: string[]) => invoke<void>("media_resume", { paused });
export const approvalPopup = (show: boolean, height?: number) => invoke<void>("approval_popup", { show, height: height ?? null });
export const approvalPopupReturn = () => invoke<void>("approval_popup_return");
export const panelShow = (show: boolean) => invoke<void>("panel_show", { show });
export const panelVisible = () => invoke<boolean>("panel_visible");
/** DeepSeek's account balance (no tokens used). */
export const deepseekBalance = (key: string) => invoke<{ amount: number; currency: string }>("deepseek_balance", { key });
export const panelConfigure = (shortcut: string | null) => invoke<void>("panel_configure", { shortcut });
export interface BrowserTab {
  window: number;
  tab: number;
  active: boolean;
  title: string;
  url: string;
}
export const macTabs = (app: string, action: "list" | "switch", target: { window?: number; tab?: number; matching?: string } = {}, show = false) =>
  invoke<BrowserTab[]>("mac_tabs", { app, action, window: target.window ?? null, tab: target.tab ?? null, matching: target.matching ?? null, show });
export const macDefaultBrowser = () => invoke<string>("mac_default_browser");

// ── Start window (src-tauri/src/onboard.rs) ──────────────────────────────────
export interface OnboardTools {
  claude: string | null;
  codex: string | null;
  ollama: string | null;
  ollamaRunning: boolean;
  npm: boolean;
  brew: boolean;
  memoryGb: number;
}
export const onboardTools = async (): Promise<OnboardTools> => {
  const t = await invoke<{ claude: string | null; codex: string | null; ollama: string | null; ollama_running: boolean; npm: boolean; brew: boolean; memory_gb: number }>("onboard_tools");
  return { claude: t.claude, codex: t.codex, ollama: t.ollama, ollamaRunning: t.ollama_running, npm: t.npm, brew: t.brew, memoryGb: t.memory_gb };
};
export const onboardInstall = (name: "claude" | "codex" | "ollama") => invoke<string>("onboard_install", { name });
export const providerModels = (base: string, key: string, provider: string) => invoke<string[]>("provider_models", { base, key, provider });
export const onboardPermissions = () => invoke<{ microphone: "granted" | "denied" | "unknown" }>("onboard_permissions");
export const onboardRequestMicrophone = () => invoke<void>("onboard_request_microphone");
export const onboardRequestAutomation = (app: string) => invoke<boolean>("onboard_request_automation", { app });
export interface ReleaseInfo {
  version: string;
  name: string;
  notes: string;
  date: string;
}
export const moveFromPersonalAvailable = () => invoke<boolean>("move_from_personal_available");
export const moveFromPersonal = () => invoke<void>("move_from_personal");
export const updateReleases = () => invoke<ReleaseInfo[]>("update_releases");
/** Adds/replaces or removes an E.V reminder in the Mac's Calendar (rings even when E.V is closed). */
export const calendarSync = (request: Record<string, unknown>) => invoke<void>("calendar_sync", { request });

// ── The E.V notch (src-tauri/src/notch_window.rs) ─────────────────────────────

export type NotchGeometry = { hasNotch: boolean; width: number; height: number };
export const notchGeometry = () => invoke<NotchGeometry>("notch_geometry");
export const notchEnable = (on: boolean) => invoke<void>("notch_enable", { on });
export const notchResize = (width: number, height: number) => invoke<void>("notch_resize", { width, height });
export const notchKeyboard = (on: boolean) => invoke<void>("notch_keyboard", { on });
export const notchOpenMain = () => invoke<void>("notch_open_main");
export const notchMainVisible = (visible: boolean) => invoke<void>("notch_main_visible", { visible });
export const notchDragOut = (paths: string[]) => invoke<void>("notch_drag_out", { paths });
export const notchAnswer = (id: string, decision: "allow" | "always" | "deny") => invoke<void>("notch_answer", { id, decision });

export type Caffeine = { on: boolean; lid: boolean; lidReady: boolean; until: number | null; batteryLimit: number | null; ended: string | null };
export const caffeineSet = (on: boolean, lid: boolean, minutes?: number, batteryLimit?: number) =>
  invoke<Caffeine>("caffeine_set", { on, lid, minutes: minutes || null, batteryLimit: batteryLimit || null });
export const caffeineStatus = () => invoke<Caffeine>("caffeine_status");
export const caffeineRemovePermission = () => invoke<Caffeine>("caffeine_remove_permission");

export type FileHit = { path: string; name: string; folder: string; when: string; score: number; named: boolean };
export type FileSearch = { results: FileHit[]; clear: boolean; key: string; empty: boolean };
export const findMyFiles = (query: string, picks: Record<string, string> = {}) => invoke<FileSearch>("find_my_files", { query, picks });
export const fileOpen = (path: string, reveal = false) => invoke<void>("file_open", { path, reveal });
export const filesExist = (paths: string[]) => invoke<boolean[]>("files_exist", { paths });

export type SongInfo = {
  playing: boolean;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  elapsed?: number;
  rate?: number;
  timestamp?: number;
  fetchedAt: number;
  app?: string;
  artwork?: string;
  artworkMime?: string;
};
export const nowPlayingInfo = (artwork = false) => invoke<SongInfo | null>("now_playing_info", { artwork });
export type Lyrics = { synced: string; plain: string };
export const lyricsFor = (artist: string, title: string, album: string | undefined, duration: number | undefined, save: boolean) =>
  invoke<Lyrics | null>("lyrics", { artist, title, album: album ?? null, duration: duration ?? null, save });
export const lyricsClear = () => invoke<void>("lyrics_clear");

// ── The instant router (src-tauri/helpers/routerlib.swift) ─────────────────────
export type RouteReply = { available: boolean; tool: string; values?: Record<string, unknown>; ms?: number; reason?: string };
export const routeRequest = (request: { tools: unknown; learned: { text: string; tool: string }[]; text: string }) => invoke<RouteReply>("route_request", { request });
export const routePrewarm = () => invoke<boolean>("route_prewarm");
