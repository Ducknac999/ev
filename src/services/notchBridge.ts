import { emitTo, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { clipConfigure, lyricsClear, notchEnable, notchMainVisible, notchOpenMain } from "../lib/ipc";
import { useChats } from "../store/chats";
import { useSettings } from "../store/settings";
import { useVoice } from "../store/voice";
import type { Chat, Settings } from "../types";
import { typedReply } from "./announce";
import { isRunning, sendMessage, stopGeneration } from "./chatRunner";
import { openPicked } from "./filePicker";
import { enterTalkMode, exitTalkMode } from "./voiceControl";

/**
 * The E.V notch (src-tauri/src/notch_window.rs, components/Notch.tsx) is only a view: chats,
 * Talk mode and settings live here in the main window, which sends it what to show and does
 * what it asks. Voice moments (listening, answers, approvals) reach it through the same notch
 * messages Vorssaint gets (src-tauri/src/notch.rs).
 */

export interface NotchChat {
  id: string;
  title: string;
  running: boolean;
  messages: { id: string; role: "user" | "assistant"; content: string; pending?: boolean }[];
}

export interface NotchState {
  talk: { on: boolean; title: string | null };
  chat: NotchChat | null;
  chatPanels: boolean;
  lyrics: Settings["notch"]["lyrics"];
  caffeine: Settings["notch"]["caffeine"];
  hideInFullscreen: boolean;
  /** Clipboard history is on (the notch shows its tab). */
  clipboard: { on: boolean; shortcut: string };
}

export type NotchRequest =
  | { kind: "send"; text: string }
  | { kind: "talk"; on: boolean }
  | { kind: "chatPanels"; on: boolean }
  | { kind: "openMain" }
  | { kind: "stop" }
  | { kind: "pickFile"; key: string; path: string };

function aiChats(): Chat[] {
  return useChats.getState().chats.filter((c) => c.kind === "ai");
}

/** The notch's chat: the one in Talk mode, else the quick panel's pick, else the most recent. */
function currentChat(): Chat | null {
  const chats = aiChats();
  const talk = useVoice.getState().talkChatId;
  const picked = useSettings.getState().settings.panel.chatId;
  return (
    chats.find((c) => c.id === talk) ??
    chats.find((c) => c.id === picked && !c.archived) ??
    [...chats].filter((c) => !c.archived).sort((a, b) => b.updatedAt - a.updatedAt)[0] ??
    null
  );
}

function target(): string {
  const chat = currentChat();
  if (chat) {
    if (chat.archived) useChats.getState().restoreChat(chat.id);
    return chat.id;
  }
  return useChats.getState().createChat(useSettings.getState().settings);
}

function snapshot(): NotchState {
  const { settings } = useSettings.getState();
  const chat = currentChat();
  const talkId = useVoice.getState().talkChatId;
  const talkChat = talkId ? aiChats().find((c) => c.id === talkId) : undefined;
  return {
    talk: { on: Boolean(talkId), title: talkChat?.title ?? null },
    chat: chat && {
      id: chat.id,
      title: chat.title,
      running: isRunning(chat.id),
      messages: chat.messages
        .filter((m) => !m.divider && (m.content || m.pending))
        .slice(-6)
        .map((m) => ({ id: m.id, role: m.role, content: m.content.slice(-1200), ...(m.pending ? { pending: true } : {}) })),
    },
    chatPanels: settings.notch.chatPanels,
    lyrics: settings.notch.lyrics,
    caffeine: settings.notch.caffeine,
    hideInFullscreen: settings.notch.hideInFullscreen,
    clipboard: { on: settings.notch.clipboard.enabled, shortcut: settings.notch.clipboard.shortcut },
  };
}

let timer: number | null = null;
let lastSent = "";

function push(now = false): void {
  if (useSettings.getState().settings.notch.mode !== "ev") return;
  if (timer !== null && !now) return;
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(
    () => {
      timer = null;
      const state = JSON.stringify(snapshot());
      if (state === lastSent) return;
      lastSent = state;
      void emitTo("notch", "notch-state", JSON.parse(state)).catch(() => {});
    },
    now ? 0 : 150,
  );
}

function setChatPanels(on: boolean): void {
  const { settings, save } = useSettings.getState();
  if (settings.notch.chatPanels !== on) void save({ ...settings, notch: { ...settings.notch, chatPanels: on } });
}

function handle(request: NotchRequest): void {
  switch (request.kind) {
    case "send": {
      const text = request.text.trim();
      const chatId = target();
      if (!text || isRunning(chatId)) return;
      void sendMessage(chatId, text, { speak: false, ...typedReply(text) });
      break;
    }
    case "talk":
      if (request.on) void enterTalkMode(target());
      else exitTalkMode();
      break;
    case "chatPanels":
      setChatPanels(request.on);
      break;
    case "openMain":
      void notchOpenMain().catch(() => {});
      break;
    case "stop": {
      const chat = currentChat();
      if (chat) stopGeneration(chat.id);
      break;
    }
    case "pickFile":
      void openPicked(request.key, request.path).catch(() => {});
      break;
  }
  push(true);
}

/** Applies Settings → Notch: the E.V notch on or off, and E.V's window shown or hidden. */
function apply(settings: Settings, previous?: Settings): void {
  const ev = settings.notch.mode === "ev";
  if (!previous || previous.notch.mode !== settings.notch.mode) void notchEnable(ev).catch(() => {});
  // Without the E.V notch there'd be no way back to E.V: its window always shows then.
  const visible = settings.notch.chatPanels || !ev;
  const wasVisible = previous ? previous.notch.chatPanels || previous.notch.mode !== "ev" : true;
  if (visible !== wasVisible) void notchMainVisible(visible).catch(() => {});
  if (previous && previous.notch.lyrics === "keep" && settings.notch.lyrics === "never") void lyricsClear().catch(() => {});
  if (!previous || previous.notch.clipboard !== settings.notch.clipboard || previous.notch.mode !== settings.notch.mode) configureClipboard(settings);
}

/** Problems setting up clipboard history (shown in Settings → Notch). */
export const useClipboardError = create<{ error: string }>(() => ({ error: "" }));

/** Clipboard history lives in the E.V notch: on only with it. */
function configureClipboard(settings: Settings): void {
  const c = settings.notch.clipboard;
  const on = c.enabled && settings.notch.mode === "ev";
  void clipConfigure(on, c.limit, c.ignoreApps, c.shortcut || null)
    .then(() => useClipboardError.setState({ error: "" }))
    .catch((err) => {
      const text = String(err);
      useClipboardError.setState({
        error: text.includes("PERMISSION:accessibility") ? "The shortcut needs Accessibility: System Settings → Privacy & Security → Accessibility → E.V." : text,
      });
    });
}

let started = false;

export function startNotch(): void {
  if (started) return;
  started = true;
  apply(useSettings.getState().settings);
  useSettings.subscribe((state, previous) => {
    if (state.settings.notch !== previous.settings.notch) apply(state.settings, previous.settings);
    push();
  });
  useChats.subscribe(() => push());
  useVoice.subscribe((state, previous) => {
    if (state.talkChatId !== previous.talkChatId) push(true);
  });
  void listen("notch-ready", () => {
    lastSent = "";
    push(true);
  }).catch(() => {});
  void listen<NotchRequest>("notch-request", (event) => handle(event.payload)).catch(() => {});
}
