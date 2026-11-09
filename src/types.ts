export type ProviderId = "claude" | "gemini" | "groq" | "deepseek" | "openai" | "openrouter" | "xai" | "anthropic" | "mistral" | "ollama" | "custom";
export type KeyedProviderId = Exclude<ProviderId, "claude">;

export interface ModelRef {
  provider: ProviderId;
  model: string;
}

export type Role = "user" | "assistant";

export type AttachmentKind = "image" | "pdf" | "text" | "audio" | "video" | "binary";

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
  /** Absolute path of E.V's stored copy (app data folder). */
  path: string;
  /** Small JPEG data URL shown in the chat for images. */
  preview?: string;
}

export type ToolStatus = "queued" | "pending" | "running" | "done" | "denied" | "error";

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "gap";
  text: string;
  /** Line number in the old (del/ctx) or new (add) file. */
  line?: number;
}

/** What an approval card shows before the user decides. */
export type ToolPreview =
  | { kind: "command"; command: string; cwd: string }
  | { kind: "diff"; path: string; isNew: boolean; lines: DiffLine[]; truncated: boolean }
  | { kind: "target"; label: string; value: string }
  /** Picture of what is about to happen (kept in memory only, never saved with the chat). */
  | { kind: "screen"; imageId: string; caption: string };

export type PlanStepStatus = "todo" | "doing" | "done" | "skipped";

/** A job plan shown to the user; once approved, actions inside it run without asking again. */
export interface PlanView {
  title: string;
  steps: string[];
  progress: PlanStepStatus[];
  files: string[];
  commands: string[];
  apps: string[];
  access: string[];
  /** Set when this plan replaces an earlier one. */
  changeReason?: string;
  /** The project copy the job runs in, if any. */
  safeCopy?: boolean;
}

export interface ReviewFile {
  path: string;
  status: "added" | "modified" | "deleted";
  lines: DiffLine[];
  truncated: boolean;
}

/** What a job changed in its safe copy, waiting for Keep or Throw away. */
export interface ReviewView {
  title: string;
  project: string;
  shadow: string;
  files: ReviewFile[];
}

/** One action an AI asked to take, shown in the chat as a card. */
export interface ToolStep {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** One-line human description, e.g. "Search this Mac for folders named E.V". */
  title: string;
  status: ToolStatus;
  /** Whether this action needs the user's approval (see `approvalFor`). */
  needsApproval: boolean;
  /** Ran without a card because the approval rule allows it (web search, reading the project…). */
  auto?: boolean;
  /** Needs the full passphrase in Talk mode even inside an approval window. */
  strict?: boolean;
  /** Shared by every card approved together; the last one carries the buttons. */
  approvalId?: string;
  groupSize?: number;
  groupLast?: boolean;
  approvedByVoice?: boolean;
  /** How to reverse a memory or schedule change (shown as Undo). */
  undo?: UndoInfo;
  plan?: PlanView;
  /** make_graph: the graph drawn under the card. */
  graph?: import("./providers/agent/graph").GraphResult;
  /** split_into_helpers / agent: each helper's part and progress. */
  helpers?: { title: string; status: "working" | "done" | "failed"; note: string }[];
  /** Model label shown on a helpers card (sub-agents run on the chat's own model). */
  helpersModel?: string;
  /** ask_user: the question, its choices, and the answer once given (null = skipped). */
  question?: { question: string; options: { label: string; description?: string }[]; multi: boolean; answer?: string[] | null };
  review?: ReviewView;
  /** Needs approval because it goes beyond the plan the user approved. */
  outsidePlan?: boolean;
  /** Can't be taken back (send, delete, install…). */
  final?: boolean;
  /** What "Approve always" would cover for this action (absent: approve now only). */
  always?: { key: string; label: string };
  /** Ran or was approved through an "Approve always". */
  alwaysApproved?: boolean;
  preview?: ToolPreview;
  /** True when the action reaches outside the session's project folder. */
  outside?: boolean;
  /** Shortened output shown under the card. */
  result?: string;
}

export type MessageBlock = { type: "text"; text: string } | { type: "tool"; step: ToolStep };

/** Provider-native record of an agent turn (model output + tool results), replayed in later turns. */
export interface AgentTranscript {
  provider: KeyedProviderId;
  items: unknown[];
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  attachments?: Attachment[];
  createdAt: number;
  model?: ModelRef;
  error?: string;
  pending?: boolean;
  /** Name of the API key that produced this reply (keyed providers only). */
  keyName?: string;
  /** Text and action cards in the order the AI produced them. */
  blocks?: MessageBlock[];
  /** What the model thought before answering (thinking switch on). */
  reasoning?: string;
  transcript?: AgentTranscript;
  /** Why this answer was or wasn't spoken ("🔈 Spoken: you asked by voice"). */
  voiceNote?: string;
  /** Tokens this answer used (all its steps), as the provider counted them. */
  usage?: { input: number; cached: number; output: number; steps: number };
  /** Sent to the model with this message but not shown (e.g. SUMMARY.md after /clear). */
  hiddenContext?: string;
  /** Done by E.V itself with no AI call (instant commands like "pause the music"). */
  instant?: boolean;
  /** Done by repeating a learned task with no AI call; `request` is what the user asked. */
  learned?: { taskId: string; request: string };
  /** The answer is being fact-checked against its sources before it is shown. */
  checking?: boolean;
  /** Result of the fact-check for answers built on live data. */
  factCheck?: "verified" | "corrected" | "unchecked";
  /** Marks the "context cleared" divider created by /clear, or a summary made by /compact. */
  divider?: "clear" | "compact";
}

export type ChatStatus = "idle" | "streaming" | "error";

/** ai: Gemini/Groq chat agent · claude: Claude Code terminal · shell: plain terminal · command: one command. */
export type SessionKind = "ai" | "claude" | "codex" | "shell" | "command" | "browser";

/** Sessions that run in a terminal (a PTY): Claude Code, shells and commands. */
export const isTerminalKind = (kind: SessionKind) => kind === "claude" || kind === "codex" || kind === "shell" || kind === "command";

export interface PauseState {
  /** Chat that took over the locked model. */
  byChatId: string;
  byChatTitle: string;
  at: number;
}

export interface Chat {
  id: string;
  kind: SessionKind;
  /** Project folder the session works in. */
  cwd?: string;
  /** Shell command for `command` sessions. */
  command?: string;
  /** AI chats: messages before this index are no longer sent to the model (/clear). */
  contextStart?: number;
  /**
   * AI chats: earlier conversation folded into a summary so long chats keep their history without
   * resending it. `through` is the last message the summary covers.
   */
  compact?: { through: string; summary: string; count: number };
  title: string;
  /** The user named it: nothing renames it again (until they choose "Let E.V name it"). */
  titleIsCustom: boolean;
  /** E.V already named it from what it's about (reset by /clear, so a new topic gets a new name). */
  aiNamed?: boolean;
  model: ModelRef;
  /** Thinking switch for models that have one (DeepSeek); off when absent. */
  thinking?: boolean;
  messages: ChatMessage[];
  status: ChatStatus;
  paused: PauseState | null;
  /** Body collapsed in place; the chat stays live in memory. */
  collapsed: boolean;
  /** Closed with history: hidden from the workspace, listed in the Closed Chats drawer. */
  archived: boolean;
  archivedAt?: number;
  /** Sequence number behind the default "Chat N" title; lowest free number is reused. */
  seq: number;
  /** Set when a response finished while the chat was collapsed or archived. */
  unseen: boolean;
  /** Claude Code session id: resumed when the session restarts. Legacy Claude chats keep theirs too. */
  claudeSessionId?: string;
  /** A job's safe copy of the project, waiting for review (Keep / Throw away). */
  workspace?: { project: string; shadow: string; title: string };
  /** Key chosen by hand in the key picker; absent means automatic selection. */
  pinnedKeyId?: string;
  /** Key the chat used most recently, preferred next time when it is free. */
  lastKeyId?: string;
  createdAt: number;
  updatedAt: number;
}

export type LayoutMode = "hud" | "focus" | "tray";

export interface ApiKey {
  /** Stable id so renames and edits keep the key's usage history. */
  id: string;
  name: string;
  key: string;
}

export interface ProviderSettings {
  keys: ApiKey[];
  /** Extra model ids beyond the built-in catalog. */
  customModels: string[];
  /** Requests-per-day limits typed in by the user (model id → limit), e.g. copied from AI Studio. */
  dailyLimits: Record<string, number>;
}

export interface TerminalPreset {
  id: string;
  name: string;
  command: string;
  cwd?: string;
}

export interface Settings {
  version: 1;
  providers: Record<KeyedProviderId, ProviderSettings>;
  claude: {
    cwd: string;
    customModels: string[];
  };
  voice: {
    ttsVoice: string;
    ttsRate: number;
    sttModelPath: string;
    sttLanguage: string;
    /** Talk mode only acts on speech that starts with "Hey E.V" (or follows an answer). */
    wakeWord: boolean;
    /** When E.V answers out loud (one rule everywhere; see services/announce.ts). */
    replies: {
      /** Typed requests: answer silently (text) or out loud too. */
      typed: "silent" | "speak";
      /** Spoken commands ("next song", "pause"): chime + notch line, or out loud. (Name kept for saved settings.) */
      tasksOverMusic: "notch" | "speak";
      /** Reminders, approvals, failed tasks: always out loud (plus notch), or notch only. */
      important: "speak" | "notch";
    };
    /** Your spellings for names and words the speech engine gets wrong ("Vorssaint", "Ducknac"). */
    dictionary: string[];
    /**
     * Dictation into any app: hold `shortcut`, talk, let go — the words are typed where your cursor
     * is. `polished`: Apple's on-device model also fixes self-corrections. `doubleCommand`: tap ⌘
     * twice to turn hands-free (Talk mode) on or off.
     */
    dictation: {
      enabled: boolean;
      shortcut: string;
      polished: boolean;
      doubleCommand: boolean;
      /** A space after each dictation, so back-to-back ones don't run together. */
      trailingSpace: boolean;
      /** Polished became opt-in (it's slower): applied once to older settings. */
      v2?: boolean;
    };
    /** Seconds E.V keeps listening after an answer without "Hey E.V" (2–15). */
    conversationSeconds: number;
    /** The conversation window became "after every answer, 8 s" (applied once to older settings). */
    windowV2?: boolean;
    /** When a reply needs no "Hey E.V": only after E.V asks you something, never, or after every answer. */
    followUps: "asked" | "never" | "always";
    /** A reply without "Hey E.V" may be at most this much quieter than your "Hey E.V" (dB). Learned from corrections. */
    replyGateDb: number;
    /** macOS echo cancellation for the mic — only useful with speakers; it also turns other audio down. */
    echoCancellation: boolean;
    /** Turbo replies: Gemini Live speaks conversational answers (Google's voice); tasks still go the normal way. */
    turbo: boolean;
    turboVoice: string;
    turboModel: string;
    /** Hold a shortcut anywhere, speak, let go: the request goes to E.V. */
    holdToTalk: {
      enabled: boolean;
      /** "control+option+space", "fn", "rightoption"… */
      shortcut: string;
      /** Read the answer aloud. */
      speak: boolean;
    };
  };
  /** Shortcuts that answer a waiting approval from any app (key combos). */
  approvalKeys: { approve: string; always: string; cancel: string };
  /** The quick panel: its shortcut, and the chat it shows (null = the most recent). */
  panel: { shortcut: string; chatId: string | null };
  /**
   * The notch: E.V's own (with the music card, drop box and ☕), the Vorssaint app's, or none.
   * `chatPanels` off: E.V's window stays hidden and E.V lives in the notch.
   */
  /** Instant actions decided on this Mac (Apple's on-device model, no tokens) before the AI. */
  router: { enabled: boolean };
  notch: {
    mode: "ev" | "vorssaint" | "off";
    chatPanels: boolean;
    /** Synced lyrics: keep the last 100 songs on the Mac (~0.5 MB), or never save them. */
    lyrics: "keep" | "never";
    caffeine: {
      /** ☕ keeps the Mac awake with the lid closed too (password once to set up). */
      lid: boolean;
      /** Turns ☕ off by itself below this battery % (0 = never). */
      batteryLimit: number;
      /** ☕ turns off by itself after this many minutes (0 = when you turn it off). */
      minutes: number;
    };
    /** Which of the notch's sections show (Clipboard has its own switch: `clipboard.enabled`). */
    features: { chat: boolean; music: boolean; shelf: boolean; dictation: boolean; caffeine: boolean };
    /** The notch hides while an app is full screen (it would cover the app's top bar), like Vorssaint's. */
    hideInFullscreen: boolean;
    /** Clipboard history in the notch: what you copy, kept on this Mac (passwords never). */
    clipboard: {
      enabled: boolean;
      /** Opens the history from any app ("shift+command+c"). */
      shortcut: string;
      /** How many to keep (pinned ones don't count). */
      limit: number;
      /** Apps whose copies are never kept (names or bundle IDs). */
      ignoreApps: string[];
    };
  };
  /** Quitting: ⌘Q keeps the notch (clipboard, dictation, music, ☕) running; E.V opens at login. */
  background: { keepNotchOnQuit: boolean; openAtLogin: boolean };
  /** DeepSeek spending: a daily limit in the account's currency (0 = no limit). */
  spending: { dailyLimit: number };
  /** A screen question needs a picture but the chat's model can't see pictures: ask, use Flash · Vision for that look, or read the screen as text. */
  screenPicture: "ask" | "vision" | "text";
  /** "Custom server": any OpenAI-style chat-completions server (base address up to /v1). */
  customServer: { baseUrl: string };
  /** Coding agents in the terminal: Claude Code, Codex, or both (set in the start window). */
  agents: { claude: boolean; codex: boolean };
  /** Top bar style: everything, or icons only. */
  topBarStyle: "full" | "compact";
  /** Top bar: always on screen, or only when the cursor reaches the top (⌥⌘B shows/hides it too). */
  topBarShow: "always" | "hover";
  /** The start window opens at this step (0–6) next time, e.g. Permissions after moving in. */
  onboardStart?: number;
  /** This E.V took over the personal build's data (Settings → General → Move my E.V into this app). */
  movedFromPersonal?: boolean;
  /** The start window was finished (or closed); it doesn't come back by itself. */
  onboarded: boolean;
  defaultModel: ModelRef;
  systemPrompt: string;
  terminal: {
    fontSize: number;
    presets: TerminalPreset[];
    /** Reopen Claude Code sessions where they left off when E.V starts. */
    resumeClaude: boolean;
  };
  /** Most recently used project folders, newest first. */
  recentFolders: string[];
  reminders: {
    /** Minutes before an event for the early reminder; 0 = only at the event time. */
    leadMinutes: number;
  };
}

export interface LockConflict {
  requestingChatId: string;
  holderChatId: string;
  model: ModelRef;
}

export type UndoInfo =
  | { type: "memory"; id: string; before?: MemoryItem }
  | { type: "forgot"; item: MemoryItem }
  | { type: "suggestion"; text: string; kind: MemoryKind }
  | { type: "event-added"; id: string }
  | { type: "event-changed"; before: ScheduleItem }
  | { type: "event-removed"; item: ScheduleItem }
  | { type: "system"; before: { volume?: number | null; muted?: boolean | null; darkMode?: boolean | null } };

export type MemoryKind = "about" | "preference" | "rule" | "lesson" | "word" | "note";

/** Something the user taught E.V. "gideon" memories reach every AI; "chat" ones a single chat. */
export interface MemoryItem {
  id: string;
  scope: "gideon" | "chat";
  /** Chat that owns a "chat" memory (and where any memory was learned). */
  chatId?: string;
  chatTitle?: string;
  kind: MemoryKind;
  text: string;
  createdAt: number;
  updatedAt: number;
  /** Tool step or suggestion that created it (for Undo and "Remember this?" chips). */
  sourceStepId?: string;
}

export type Repeat = "none" | "daily" | "weekdays" | "weekly" | "monthly" | "yearly";

/** An event the user explicitly added. `start` is wall-clock time in `timeZone`. */
export interface ScheduleItem {
  id: string;
  title: string;
  start: string;
  timeZone: string;
  repeat: Repeat;
  /** Last day a repeating event happens (YYYY-MM-DD). */
  until?: string;
  notes?: string;
  createdAt: number;
}
