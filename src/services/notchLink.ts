import { listen } from "@tauri-apps/api/event";
import { controlCreated, controlMeta } from "../lib/ipc";
import { activeChats, useChats } from "../store/chats";
import { useSettings } from "../store/settings";
import type { SessionKind } from "../types";
import { closeChat } from "./chatLifecycle";
import { restartTerminal, useTerminals } from "./terminals";

let started = false;
let timer: number | null = null;

function pushMeta(): void {
  timer = null;
  const { chats, focusedChatId } = useChats.getState();
  const runtimes = useTerminals.getState().byId;
  const sessions: Record<string, Record<string, unknown>> = {};
  for (const chat of activeChats(chats)) {
    if (chat.kind === "ai" || chat.kind === "browser") continue;
    const runtime = runtimes[chat.id];
    sessions[chat.id] = {
      kind: chat.kind,
      cwd: chat.cwd ?? "~",
      created: chat.createdAt / 1000,
      // Restored Command sessions wait for Run; the notch lists them and can start them.
      notStarted: runtime?.notStarted ?? false,
      // The Claude Code conversation this session shows, so the notch can follow it (resume, /clear).
      claudeSession: chat.claudeSessionId ?? "",
      title: chat.title,
      unread: runtime?.unread ?? false,
      attention: runtime?.attention ?? false,
      selected: chat.id === focusedChatId,
      foreground: runtime?.foreground ?? "",
    };
  }
  const settings = useSettings.getState().settings;
  void controlMeta(
    sessions,
    settings.terminal.presets.map((p) => ({ name: p.name, command: p.command, enter: true })),
    settings.recentFolders,
    document.visibilityState === "visible",
  ).catch(() => {});
}

function schedule(): void {
  if (timer === null) timer = window.setTimeout(pushMeta, 250);
}

/**
 * Keeps the Vorssaint notch in sync with E.V's terminal sessions and carries out what it asks
 * for (new session, close, focus) through the normal workspace actions.
 */
export async function startNotchLink(): Promise<void> {
  if (started) return;
  started = true;
  useChats.subscribe(schedule);
  useTerminals.subscribe(schedule);
  useSettings.subscribe(schedule);
  document.addEventListener("visibilitychange", schedule);
  pushMeta();

  await listen<{ ref: string; kind: string; cwd?: string | null; command?: string | null }>("control-new", ({ payload }) => {
    const settings = useSettings.getState().settings;
    const kind: SessionKind = payload.kind === "shell" ? "shell" : payload.kind === "command" ? "command" : "claude";
    const id = useChats.getState().createSession(settings, {
      kind,
      cwd: payload.cwd || settings.recentFolders[0] || "~",
      command: payload.command ?? undefined,
      background: true,
    });
    // The terminal spawns as soon as the session exists; report its id back to the notch.
    window.setTimeout(() => void controlCreated(payload.ref, id).catch(() => {}), 300);
  });
  await listen<{ id: string }>("control-close", ({ payload }) => closeChat(payload.id));
  await listen<{ id: string }>("control-start", ({ payload }) => {
    const chat = useChats.getState().chats.find((c) => c.id === payload.id);
    if (chat && useTerminals.getState().byId[chat.id]?.notStarted) restartTerminal(chat);
  });
  await listen<{ id: string | null }>("control-focus", ({ payload }) => {
    if (!payload.id) return;
    const store = useChats.getState();
    if (store.layout === "focus") store.openInFocus(payload.id);
    else store.focusChat(payload.id);
  });
}
