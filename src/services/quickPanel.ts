import { emitTo, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { panelConfigure, panelShow, panelVisible } from "../lib/ipc";
import { canThink, modelLabel, PROVIDERS, seesImages } from "../providers/catalog";
import { useChats } from "../store/chats";
import { useDrafts } from "../store/drafts";
import { useSettings } from "../store/settings";
import { useVoice } from "../store/voice";
import type { Chat, ChatMessage, ModelRef } from "../types";
import { answerQuestion } from "./questions";
import { isRunning, sendMessage, stopGeneration } from "./chatRunner";
import { enterTalkMode, exitTalkMode } from "./voiceControl";

/**
 * The quick panel (src-tauri/src/panel.rs): a small window over any app showing one E.V chat.
 * Chats still run here in the main window; this sends the panel what to show and does what the
 * panel asks (send, switch chat, change model, answer a question). The panel is only a view.
 */

export interface PanelStep {
  id: string;
  title: string;
  status: string;
  question?: { question: string; options: { label: string; description?: string }[]; multi: boolean; answer?: string[] | null };
}

export interface PanelMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  steps: PanelStep[];
  attachments: { name: string; preview?: string }[];
  error?: string;
  pending?: boolean;
  instant?: boolean;
}

export interface PanelChat {
  id: string;
  title: string;
  updatedAt: number;
  archived: boolean;
}

export interface PanelState {
  chats: PanelChat[];
  chat: {
    id: string;
    title: string;
    model: ModelRef;
    modelLabel: string;
    thinking: boolean;
    canThink: boolean;
    seesImages: boolean;
    running: boolean;
    messages: PanelMessage[];
  } | null;
  models: { model: ModelRef; label: string }[];
  drafts: { id: string; name: string; status: string; error?: string }[];
  /** The one chat in Talk mode (any chat, not only the panel's), or null. */
  talk: { chatId: string; title: string } | null;
}

export type PanelRequest =
  | { kind: "send"; text: string }
  | { kind: "switch"; chatId: string }
  | { kind: "new" }
  | { kind: "model"; model: ModelRef }
  | { kind: "think"; on: boolean }
  | { kind: "talk"; on: boolean }
  | { kind: "stop" }
  | { kind: "answer"; stepId: string; answer: string[] | null }
  | { kind: "files"; files: { name: string; mime: string; data: string }[] }
  | { kind: "paths"; paths: string[] }
  | { kind: "removeDraft"; id: string }
  | { kind: "visionAndSend"; text: string; files: { name: string; mime: string; data: string }[]; paths: string[] }
  | { kind: "hide" };

/** Whether the panel is on screen (hold-to-talk types into it then). */
export const useQuickPanel = create<{ open: boolean; error: string | null }>(() => ({ open: false, error: null }));

const VISION: ModelRef = { provider: "deepseek", model: "deepseek-flash-vision" };

function aiChats(): Chat[] {
  return useChats.getState().chats.filter((c) => c.kind === "ai");
}

/** The chat the panel shows: the one picked last, else the most recent; null when there are none. */
function currentChat(): Chat | null {
  const picked = useSettings.getState().settings.panel.chatId;
  const chats = aiChats();
  return chats.find((c) => c.id === picked) ?? [...chats].filter((c) => !c.archived).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

function pick(chatId: string | null): void {
  const { settings, save } = useSettings.getState();
  if (settings.panel.chatId !== chatId) void save({ ...settings, panel: { ...settings.panel, chatId } });
}

function toPanel(m: ChatMessage): PanelMessage {
  const steps: PanelStep[] = (m.blocks ?? []).flatMap((b) =>
    b.type === "tool" ? [{ id: b.step.id, title: b.step.title, status: b.step.status, ...(b.step.question ? { question: b.step.question } : {}) }] : [],
  );
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    ...(m.reasoning ? { reasoning: m.reasoning } : {}),
    steps,
    attachments: (m.attachments ?? []).map((a) => ({ name: a.name, preview: a.preview })),
    ...(m.error ? { error: m.error } : {}),
    ...(m.pending ? { pending: true } : {}),
    ...(m.instant ? { instant: true } : {}),
  };
}

function snapshot(): PanelState {
  const chat = currentChat();
  return {
    chats: aiChats()
      .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, archived: c.archived }))
      .sort((a, b) => b.updatedAt - a.updatedAt),
    chat: chat && {
      id: chat.id,
      title: chat.title,
      model: chat.model,
      modelLabel: modelLabel(chat.model),
      thinking: Boolean(chat.thinking),
      canThink: canThink(chat.model),
      seesImages: seesImages(chat.model.model),
      running: isRunning(chat.id),
      messages: chat.messages.filter((m) => !m.divider).map(toPanel),
    },
    models: PROVIDERS.deepseek.models.map((m) => ({ model: { provider: "deepseek" as const, model: m.id }, label: m.label })),
    talk: talkInfo(),
    drafts: chat ? (useDrafts.getState().byChat[chat.id] ?? []).map((d) => ({ id: d.id, name: d.name, status: d.status, ...(d.error ? { error: d.error } : {}) })) : [],
  };
}

function talkInfo(): PanelState["talk"] {
  const chatId = useVoice.getState().talkChatId;
  const chat = chatId ? useChats.getState().chats.find((c) => c.id === chatId) : undefined;
  return chatId && chat ? { chatId, title: chat.title } : null;
}

/** Whether the panel is open on this chat, so its reply is on screen. */
export function panelShowing(chatId: string): boolean {
  return useQuickPanel.getState().open && currentChat()?.id === chatId;
}

let timer: number | null = null;
let lastSent = "";

/** Sends the panel what to show, at most every 120 ms while answers stream in. */
function push(now = false): void {
  if (!useQuickPanel.getState().open) return;
  if (timer !== null && !now) return;
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(
    () => {
      timer = null;
      const state = JSON.stringify(snapshot());
      if (state === lastSent) return;
      lastSent = state;
      void emitTo("panel", "panel-state", JSON.parse(state)).catch(() => {});
    },
    now ? 0 : 120,
  );
}

/** A chat to act on: the panel's, or a new one. Closed chats are reopened first. */
function target(): string {
  const chat = currentChat();
  if (chat) {
    if (chat.archived) useChats.getState().restoreChat(chat.id);
    return chat.id;
  }
  const id = useChats.getState().createChat(useSettings.getState().settings);
  pick(id);
  return id;
}

function fromBase64(data: string): Uint8Array<ArrayBuffer> {
  const raw = atob(data);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function addFiles(chatId: string, files: { name: string; mime: string; data: string }[]): void {
  if (!files.length) return;
  useDrafts.getState().add(
    chatId,
    files.map((f) => new File([fromBase64(f.data)], f.name, { type: f.mime })),
  );
}

/** Sends once the attachments finish storing (a few seconds at most), like pressing Enter in E.V. */
async function send(chatId: string, text: string): Promise<void> {
  for (let i = 0; i < 25 && (useDrafts.getState().byChat[chatId] ?? []).some((d) => d.status === "uploading"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const attachments = useDrafts.getState().take(chatId);
  if (!text.trim() && !attachments.length) return;
  await sendMessage(chatId, text.trim(), { speak: false, attachments });
}

function handle(request: PanelRequest): void {
  switch (request.kind) {
    case "send": {
      const chatId = target();
      if (isRunning(chatId)) return;
      void send(chatId, request.text);
      break;
    }
    case "switch":
      pick(request.chatId);
      break;
    case "new":
      pick(useChats.getState().createChat(useSettings.getState().settings));
      break;
    case "model": {
      const chatId = target();
      useChats.getState().requestModel(chatId, request.model);
      break;
    }
    case "think":
      useChats.getState().setThinking(target(), request.on);
      break;
    case "talk": {
      // Talk mode belongs to one chat: on here moves it to the panel's chat; off turns it off
      // wherever it is (same switch as in E.V).
      if (request.on) void enterTalkMode(target());
      else exitTalkMode();
      break;
    }
    case "stop": {
      const chat = currentChat();
      if (chat) stopGeneration(chat.id);
      break;
    }
    case "answer":
      answerQuestion(request.stepId, request.answer);
      break;
    case "files":
      addFiles(target(), request.files);
      break;
    case "paths":
      useDrafts.getState().addPaths(target(), request.paths);
      break;
    case "removeDraft": {
      const chat = currentChat();
      if (chat) useDrafts.getState().remove(chat.id, request.id);
      break;
    }
    case "visionAndSend": {
      const chatId = target();
      useChats.getState().requestModel(chatId, VISION);
      addFiles(chatId, request.files);
      if (request.paths.length) useDrafts.getState().addPaths(chatId, request.paths);
      void send(chatId, request.text);
      break;
    }
    case "hide":
      void panelShow(false).catch(() => {});
      break;
  }
  push(true);
}

let started = false;

export function startQuickPanel(): void {
  if (started) return;
  started = true;
  const configure = () => {
    void panelConfigure(useSettings.getState().settings.panel.shortcut || null)
      .then(() => useQuickPanel.setState({ error: null }))
      .catch((err) =>
        useQuickPanel.setState({
          error: String(err).includes("PERMISSION") ? "Turn on E.V in System Settings → Privacy & Security → Accessibility so the shortcut works from any app." : String(err),
        }),
      );
  };
  configure();
  useSettings.subscribe((state, previous) => {
    if (state.settings.panel.shortcut !== previous.settings.panel.shortcut) configure();
    if (state.settings.panel.chatId !== previous.settings.panel.chatId) push(true);
  });
  useChats.subscribe(() => push());
  useDrafts.subscribe(() => push());
  useVoice.subscribe((state, previous) => {
    if (state.talkChatId !== previous.talkChatId) push(true);
  });
  void listen<boolean>("panel-visible", (event) => {
    useQuickPanel.setState({ open: event.payload });
    lastSent = "";
    push(true);
  }).catch(() => {});
  void listen("panel-ready", () => {
    lastSent = "";
    push(true);
  }).catch(() => {});
  void listen<PanelRequest>("panel-request", (event) => handle(event.payload)).catch(() => {});
  void panelVisible()
    .then((open) => useQuickPanel.setState({ open }))
    .catch(() => {});
}

/** Hold-to-talk while the panel is open: the words go into its box to check before sending. */
export function dictateIntoPanel(text: string): boolean {
  if (!useQuickPanel.getState().open) return false;
  void emitTo("panel", "panel-dictation", text).catch(() => {});
  return true;
}
