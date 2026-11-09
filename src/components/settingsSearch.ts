import type { IconName } from "./Icon";

/**
 * Settings' pages, grouped like the sidebar shows them, and the search over every setting in
 * them: part of a word ("clip"), typos ("clipbord"), other words for the same thing ("keep
 * awake" → Caffeine) and phrases ("turn off the notch") all find it. Offline, no AI.
 */

export type Page =
  | "models"
  | "claude"
  | "skills"
  | "memory"
  | "learned"
  | "voice"
  | "dictation"
  | "shortcuts"
  | "notch"
  | "approvals"
  | "connections"
  | "instant"
  | "schedule"
  | "activity"
  | "general"
  | "updates";

export interface PageInfo {
  id: Page;
  label: string;
  icon: IconName;
  /** One line under the page title. */
  blurb: string;
}

export const GROUPS: { label: string; pages: PageInfo[] }[] = [
  {
    label: "AI",
    pages: [
      { id: "models", label: "Models & API keys", icon: "key", blurb: "Which AI answers, your keys, local models and what you spend." },
      { id: "claude", label: "Claude Code", icon: "terminal", blurb: "Claude Code sessions, plan limits and models." },
      { id: "skills", label: "Instructions & skills", icon: "spark", blurb: "What E.V always keeps in mind, and the skills and rules it follows." },
      { id: "memory", label: "Memory", icon: "archive", blurb: "What E.V remembers about you." },
      { id: "learned", label: "Learned tasks", icon: "refresh", blurb: "Tasks E.V learned to do the same way every time." },
    ],
  },
  {
    label: "Voice & keyboard",
    pages: [
      { id: "voice", label: "Voice & Talk mode", icon: "mic", blurb: "E.V's voice, when it speaks, and hands-free Talk mode." },
      { id: "dictation", label: "Dictation", icon: "wave", blurb: "Type by voice into any app, the clean-up and your dictionary." },
      { id: "shortcuts", label: "Shortcuts", icon: "keyboard", blurb: "Every keyboard shortcut in one place." },
    ],
  },
  {
    label: "Notch",
    pages: [{ id: "notch", label: "Notch", icon: "notch", blurb: "E.V in your Mac's notch, and what it shows." }],
  },
  {
    label: "Safety & Mac",
    pages: [
      { id: "approvals", label: "Approvals & safety", icon: "shield", blurb: "What E.V may do on its own, what it asks first, and your passphrase." },
      { id: "connections", label: "Connections", icon: "link", blurb: "Gmail, Calendar, Notes, Reminders and more, and E.V's own browser." },
      { id: "instant", label: "Instant actions", icon: "bolt", blurb: "Simple requests done on this Mac right away, with no AI." },
    ],
  },
  {
    label: "Activity",
    pages: [
      { id: "schedule", label: "Schedule", icon: "calendar", blurb: "Reminders and tasks that run later or on repeat." },
      { id: "activity", label: "Activity", icon: "history", blurb: "What E.V did, and when." },
    ],
  },
  {
    label: "App",
    pages: [
      { id: "general", label: "General", icon: "settings", blurb: "The look, the terminal and setup." },
      { id: "updates", label: "Updates", icon: "download", blurb: "Check for a new version and install it." },
    ],
  },
];

export const PAGES: PageInfo[] = GROUPS.flatMap((g) => g.pages);
export const pageInfo = (id: Page): PageInfo => PAGES.find((p) => p.id === id) ?? PAGES[0];

export interface SettingEntry {
  title: string;
  page: Page;
  /** The card it's in on that page (data-anchor). */
  anchor: string;
  /** Other words people use for it. */
  words: string;
}

export const ENTRIES: SettingEntry[] = [
  { title: "API keys", page: "models", anchor: "keys", words: "key api provider deepseek openai chatgpt gpt anthropic gemini google openrouter grok xai mistral groq account token" },
  { title: "Local model (Ollama)", page: "models", anchor: "keys", words: "local ollama offline llama private on device download model" },
  { title: "Custom server", page: "models", anchor: "keys", words: "custom server openai compatible base url lm studio self hosted" },
  { title: "More model IDs", page: "models", anchor: "keys", words: "model id new model add model" },
  { title: "Default model for new chats", page: "models", anchor: "default-model", words: "default model new chat which ai" },
  { title: "Pictures for screen questions", page: "models", anchor: "default-model", words: "screen picture vision image look see screenshot flash" },
  { title: "Spending limit", page: "models", anchor: "spending", words: "money cost spend budget limit balance price usage pay dollars daily" },
  { title: "Claude Code", page: "claude", anchor: "claude", words: "claude code session cli terminal subscription" },
  { title: "Claude plan usage and limits", page: "claude", anchor: "claude", words: "plan usage limits weekly quota opus sonnet haiku" },
  { title: "Claude folder and model aliases", page: "claude", anchor: "claude", words: "folder directory continue model alias" },
  { title: "System prompt (instructions for every chat)", page: "skills", anchor: "system-prompt", words: "prompt instructions personality behavior tone always custom instructions" },
  { title: "Skills & rules", page: "skills", anchor: "skills", words: "skills rules guidelines claude md" },
  { title: "Memory", page: "memory", anchor: "memory", words: "remember memory facts forget about me personal notes" },
  { title: "Learned tasks", page: "learned", anchor: "learned", words: "learned routine workflow recipe repeat steps" },
  { title: "E.V's voice and speech models", page: "voice", anchor: "voice-engine", words: "voice speech tts text to speech kokoro parakeet whisper speak speed accent sound download engine" },
  { title: "Turbo voice (Gemini Live)", page: "voice", anchor: "voice-engine", words: "turbo gemini live realtime fast voice" },
  { title: "Replies: when E.V talks", page: "voice", anchor: "replies", words: "speak out loud silent mute quiet reply answer talk back read aloud notch chime" },
  { title: "Hey E.V (wake word)", page: "voice", anchor: "talk-mode", words: "hey ev wake word hands free listen talk mode always listening microphone mic" },
  { title: "Follow-ups and listening time", page: "voice", anchor: "talk-mode", words: "follow up conversation keep listening seconds timeout" },
  { title: "Echo cancellation", page: "voice", anchor: "talk-mode", words: "echo speakers feedback noise" },
  { title: "Dictation into any app", page: "dictation", anchor: "dictation", words: "dictate type by voice speech to text transcribe voice typing microphone mic" },
  { title: "Dictation key", page: "dictation", anchor: "dictation", words: "right option fn globe hold key dictation shortcut" },
  { title: "Polished dictation", page: "dictation", anchor: "dictation", words: "polish self correction apple intelligence clean grammar" },
  { title: "Space after each dictation", page: "dictation", anchor: "dictation", words: "trailing space spacing" },
  { title: "Double-tap ⌘ for hands-free", page: "dictation", anchor: "dictation", words: "double tap command hands free talk mode" },
  { title: "Your dictionary", page: "dictation", anchor: "dictation", words: "dictionary names spelling words vocabulary custom words" },
  { title: "Hold to talk", page: "shortcuts", anchor: "hold-to-talk", words: "push to talk hold ptt talk to ev" },
  { title: "Quick panel shortcut", page: "shortcuts", anchor: "quick-panel", words: "quick panel option space popup mini chat spotlight" },
  { title: "Approval shortcuts", page: "shortcuts", anchor: "approval-keys", words: "approve deny cancel always allow keyboard" },
  { title: "Clipboard history shortcut", page: "shortcuts", anchor: "clipboard-key", words: "clipboard command shift c copy paste history" },
  { title: "Keyboard shortcuts in E.V", page: "shortcuts", anchor: "app-shortcuts", words: "shortcuts hotkeys keys keyboard command list" },
  { title: "E.V notch on or off", page: "notch", anchor: "notch", words: "notch vorssaint island top menu bar turn off disable" },
  { title: "Chat panels (show or hide E.V's window)", page: "notch", anchor: "notch", words: "window hide chat panels dock only notch" },
  { title: "Hide the notch in full-screen apps", page: "notch", anchor: "notch", words: "full screen fullscreen cover hide top edge" },
  { title: "Notch features", page: "notch", anchor: "notch-features", words: "music chat drop box shelf dictation history tabs features" },
  { title: "Lyrics", page: "notch", anchor: "notch-features", words: "lyrics song music karaoke words" },
  { title: "☕ Caffeine (keep the Mac awake)", page: "notch", anchor: "caffeine", words: "caffeine coffee awake sleep lid closed amphetamine battery stay on" },
  { title: "Clipboard history", page: "notch", anchor: "clipboard", words: "clipboard copy paste history copied" },
  { title: "Apps the clipboard skips", page: "notch", anchor: "clipboard", words: "password manager ignore exclude private 1password" },
  { title: "Approvals: what E.V may do", page: "approvals", anchor: "approvals", words: "permission allow ask approve safety restrictions risky level trust control" },
  { title: "Passphrase (spoken approval)", page: "approvals", anchor: "passphrase", words: "passphrase password voice approval secret phrase lock" },
  { title: "E.V Browser", page: "connections", anchor: "browser", words: "browser vivaldi web headless internet" },
  { title: "Connections (Gmail, Calendar, Notes…)", page: "connections", anchor: "connections", words: "gmail email mail calendar notes reminders youtube google connect accounts integrations apps" },
  { title: "Instant actions", page: "instant", anchor: "instant", words: "instant router apple intelligence on device no ai tokens fast free" },
  { title: "Schedule", page: "schedule", anchor: "schedule", words: "schedule reminders recurring repeat later timer alarm every day" },
  { title: "Activity", page: "activity", anchor: "activity", words: "activity log history what did audit record" },
  { title: "Top bar", page: "general", anchor: "look", words: "top bar toolbar compact hide appearance look layout" },
  { title: "Terminal", page: "general", anchor: "terminal", words: "terminal shell font tmux zsh" },
  { title: "Run setup again", page: "general", anchor: "setup", words: "setup onboarding start wizard welcome first time" },
  { title: "Updates", page: "updates", anchor: "updates", words: "update version upgrade release new latest download" },
];

const STOP = new Set("a an the my me i to of in on for and or is it its this that turn change set make how do can where find setting settings please want".split(" "));

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/⌘/g, " command ")
    .replace(/[☕…]/g, " ")
    .replace(/e\.v/g, "ev")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const words = (s: string) => normalize(s).split(" ").filter(Boolean);

/** Edit distance, stopping early once it's over `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const swap = i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1] ? prev[j - 2] ?? Infinity : Infinity;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), swap);
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** How well one typed word matches one word of a setting (0 = not at all). */
function wordScore(q: string, w: string): number {
  if (q === w) return 3;
  if (w.startsWith(q) && q.length >= 2) return 2.2;
  if (q.length >= 4 && w.includes(q)) return 1.5;
  if (q.length >= 4 && w.length >= 4) {
    const allowed = q.length >= 7 ? 2 : 1;
    // Typos: compare with the word, or its start when what's typed is shorter ("clipbor" → "clipboard").
    const d = Math.min(distance(q, w, allowed), q.length < w.length ? distance(q, w.slice(0, q.length), allowed) : allowed + 1);
    if (d <= allowed) return d === 1 ? 1.4 : 1;
  }
  return 0;
}

export interface SearchHit {
  entry: SettingEntry;
  score: number;
}

/** Settings matching what was typed, best first. */
export function searchSettings(query: string, limit = 8): SearchHit[] {
  const typed = words(query);
  const terms = typed.filter((w) => !STOP.has(w));
  const asked = terms.length ? terms : typed;
  if (!asked.length) return [];
  const hits: SearchHit[] = [];
  for (const entry of ENTRIES) {
    const title = words(entry.title);
    const extra = [...words(entry.words), ...words(pageInfo(entry.page).label)];
    let score = 0;
    let matched = 0;
    for (const q of asked) {
      const best = Math.max(0, ...title.map((w) => wordScore(q, w) * 2), ...extra.map((w) => wordScore(q, w)));
      if (best > 0) matched++;
      score += best;
    }
    if (!matched) continue;
    // Everything typed found beats only some of it.
    score *= matched === asked.length ? 1 : 0.35 * (matched / asked.length);
    // The whole phrase in the name ("clipboard history").
    if (asked.length > 1 && normalize(entry.title).includes(asked.join(" "))) score += 3;
    if (score >= 1.4) hits.push({ entry, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
