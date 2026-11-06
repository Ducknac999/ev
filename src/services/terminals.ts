import { isTerminalKind } from "../types";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { create } from "zustand";
import {
  claudeLatestSession,
  claudeSessions,
  openExternal,
  ptyAlive,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyStats,
  ptyWrite,
  type PtyEvent,
  type PtyStats,
} from "../lib/ipc";
import { activeChats, useChats } from "../store/chats";
import { useSettings } from "../store/settings";
import type { Chat } from "../types";

/** Live state of each terminal session (not persisted; processes end when E.V quits). */
export interface TerminalRuntime {
  running: boolean;
  exitCode: number | null;
  foreground: string;
  cpu: number;
  memoryMb: number;
  /** Output arrived while the session was not focused. */
  unread: boolean;
  /** The program rang the bell or sent a notification (e.g. Claude Code waiting for approval). */
  attention: boolean;
  appTitle: string;
  /** A restored command session waiting for the user to run it again. */
  notStarted?: boolean;
  error?: string;
}

interface TerminalsState {
  byId: Record<string, TerminalRuntime>;
  patch: (id: string, change: Partial<TerminalRuntime>) => void;
  remove: (id: string) => void;
}

const EMPTY: TerminalRuntime = {
  running: false,
  exitCode: null,
  foreground: "",
  cpu: 0,
  memoryMb: 0,
  unread: false,
  attention: false,
  appTitle: "",
};

export const useTerminals = create<TerminalsState>((set) => ({
  byId: {},
  patch: (id, change) => set((s) => ({ byId: { ...s.byId, [id]: { ...(s.byId[id] ?? EMPTY), ...change } } })),
  remove: (id) =>
    set((s) => {
      const { [id]: _gone, ...rest } = s.byId;
      return { byId: rest };
    }),
}));

const THEME: ITheme = {
  background: "#05070b",
  foreground: "#dbe7f7",
  cursor: "#3ee6b0",
  cursorAccent: "#05070b",
  selectionBackground: "rgba(62, 230, 176, 0.28)",
  black: "#1b2230",
  red: "#ff4d6d",
  green: "#3ddc97",
  yellow: "#ffcc4d",
  blue: "#4d9bff",
  magenta: "#c77dff",
  cyan: "#00e5ff",
  white: "#c7d3e3",
  brightBlack: "#5b6b82",
  brightRed: "#ff7a90",
  brightGreen: "#6ef0b5",
  brightYellow: "#ffe08a",
  brightBlue: "#82b8ff",
  brightMagenta: "#dba8ff",
  brightCyan: "#6ff3ff",
  brightWhite: "#ffffff",
};

interface Handle {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  host: HTMLDivElement;
  spawnedAt: number;
  /** Bumped per spawn so a replaced process's late exit event is ignored. */
  run: number;
  attached: boolean;
  disposed: boolean;
}

const handles = new Map<string, Handle>();
/** Panes that mounted before their terminal existed; filled in when it is created. */
const waitingPanes = new Map<string, HTMLElement>();
let parking: HTMLDivElement | null = null;

/** Off-screen home for terminals whose pane is not mounted, so they keep their screen state. */
function parkingLot(): HTMLDivElement {
  if (!parking) {
    parking = document.createElement("div");
    parking.className = "terminal-parking";
    parking.setAttribute("aria-hidden", "true");
    document.body.appendChild(parking);
  }
  return parking;
}

const isFocused = (id: string) => useChats.getState().focusedChatId === id && document.hasFocus();

function shellQuotePath(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

/** Arguments for `claude`: resume the session this chat last used, or start one with a known id. */
async function claudeArgs(chat: Chat): Promise<string[]> {
  // Still running in tmux from before: E.V just reattaches, Claude Code carries on as it was.
  if (keptAlive.has(chat.id)) return [];
  const cwd = chat.cwd ?? "~";
  const { resumeClaude } = useSettings.getState().settings.terminal;
  if (chat.claudeSessionId) {
    const known = await claudeSessions(cwd).catch(() => []);
    if (known.some((s) => s.id === chat.claudeSessionId) && (resumeClaude || !restoredAtLaunch.has(chat.id))) {
      return ["--resume", chat.claudeSessionId];
    }
  }
  const id = crypto.randomUUID();
  useChats.getState().setClaudeSession(chat.id, id);
  return ["--session-id", id];
}

/** Sessions that existed when E.V launched (restored, as opposed to newly opened). */
const restoredAtLaunch = new Set<string>();
/** Restored sessions tmux kept running while E.V was closed (or updating). */
const keptAlive = new Set<string>();

function onEvent(chat: Chat, handle: Handle, run: number, event: PtyEvent): void {
  if (handle.disposed || handle.run !== run) return;
  if (event.type === "output") {
    handle.term.write(event.data);
    if (!isFocused(chat.id)) {
      const current = useTerminals.getState().byId[chat.id];
      if (!current?.unread) useTerminals.getState().patch(chat.id, { unread: true });
    }
    return;
  }
  handle.term.write(`\r\n\x1b[0m\x1b[2m[process exited with code ${event.code}]\x1b[0m\r\n`);
  useTerminals.getState().patch(chat.id, { running: false, exitCode: event.code });
}

async function spawn(chat: Chat, handle: Handle): Promise<void> {
  // Codex runs as a command in its own terminal (resuming the folder's last Codex session when reopened).
  const kind = chat.kind === "claude" ? "claude" : chat.kind === "command" || chat.kind === "codex" ? "command" : "shell";
  // Codex: a session restored after a restart picks up where it was (`codex resume --last` in that folder).
  const codexCommand = chat.kind === "codex" ? (restoredAtLaunch.has(chat.id) && !keptAlive.has(chat.id) ? "codex resume --last" : "codex") : undefined;
  handle.spawnedAt = Date.now();
  const run = ++handle.run;
  useTerminals.getState().patch(chat.id, { running: true, exitCode: null, error: undefined, notStarted: false });
  try {
    await ptySpawn(
      {
        id: chat.id,
        kind,
        cwd: chat.cwd ?? "~",
        command: codexCommand ?? chat.command,
        claudeArgs: kind === "claude" ? await claudeArgs(chat) : undefined,
        cols: Math.max(20, handle.term.cols),
        rows: Math.max(5, handle.term.rows),
      },
      (event) => onEvent(chat, handle, run, event),
    );
  } catch (err) {
    const message = typeof err === "string" ? err : String(err);
    handle.term.write(`\x1b[31m${message}\x1b[0m\r\n`);
    useTerminals.getState().patch(chat.id, { running: false, error: message });
  }
}

function createHandle(chat: Chat): Handle {
  const { fontSize } = useSettings.getState().settings.terminal;
  const term = new Terminal({
    theme: THEME,
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
    fontSize,
    lineHeight: 1.15,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 10_000,
    macOptionIsMeta: true,
    convertEol: false,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new WebLinksAddon((_event, url) => void openExternal(url)));
  const host = document.createElement("div");
  host.className = "terminal-host";
  parkingLot().appendChild(host);
  term.open(host);
  try {
    fit.fit();
  } catch {
    /* zero-size parking spot */
  }

  const handle: Handle = { term, fit, search, host, spawnedAt: 0, run: 0, attached: false, disposed: false };
  term.onData((data) => void ptyWrite(chat.id, data).catch(() => {}));
  term.onBinary((data) => void ptyWrite(chat.id, data).catch(() => {}));
  term.onTitleChange((title) => useTerminals.getState().patch(chat.id, { appTitle: title }));
  const flagAttention = () => {
    if (!isFocused(chat.id)) useTerminals.getState().patch(chat.id, { attention: true });
  };
  term.onBell(flagAttention);
  // OSC 9 / OSC 777 desktop notifications (Claude Code uses these when it needs you).
  term.parser.registerOscHandler(9, () => (flagAttention(), true));
  term.parser.registerOscHandler(777, () => (flagAttention(), true));
  handles.set(chat.id, handle);
  if (chat.kind === "command" && restoredAtLaunch.has(chat.id) && !keptAlive.has(chat.id)) {
    // Re-running a command just because E.V relaunched could repeat an install or a delete.
    term.write(`\x1b[2mNot re-run after E.V restarted:\x1b[0m ${chat.command ?? ""}\r\n\x1b[2mPress Run to start it again.\x1b[0m\r\n`);
    useTerminals.getState().patch(chat.id, { running: false, exitCode: null, notStarted: true });
  } else {
    void spawn(chat, handle);
  }
  const pane = waitingPanes.get(chat.id);
  if (pane) {
    waitingPanes.delete(chat.id);
    paneDetachers.set(chat.id, mount(chat.id, handle, pane));
  }
  return handle;
}

function dispose(id: string): void {
  const handle = handles.get(id);
  if (!handle) return;
  handle.disposed = true;
  handles.delete(id);
  void ptyKill(id).catch(() => {});
  handle.term.dispose();
  handle.host.remove();
  useTerminals.getState().remove(id);
}

const paneDetachers = new Map<string, () => void>();

/** Moves the terminal into a pane; returns the function that parks it again. */
export function attachTerminal(id: string, container: HTMLElement): () => void {
  const handle = handles.get(id);
  if (!handle) {
    // The pane rendered first; attach as soon as the terminal is created.
    waitingPanes.set(id, container);
    return () => {
      if (waitingPanes.get(id) === container) waitingPanes.delete(id);
      paneDetachers.get(id)?.();
      paneDetachers.delete(id);
    };
  }
  return mount(id, handle, container);
}

function mount(id: string, handle: Handle, container: HTMLElement): () => void {
  container.appendChild(handle.host);
  handle.attached = true;
  const resize = () => {
    if (!handle.host.isConnected || handle.disposed) return;
    try {
      handle.fit.fit();
      void ptyResize(id, handle.term.cols, handle.term.rows).catch(() => {});
    } catch {
      /* hidden */
    }
  };
  const observer = new ResizeObserver(() => requestAnimationFrame(resize));
  observer.observe(container);
  requestAnimationFrame(resize);
  return () => {
    observer.disconnect();
    handle.attached = false;
    if (!handle.disposed) parkingLot().appendChild(handle.host);
  };
}

export function focusTerminal(id: string): void {
  handles.get(id)?.term.focus();
  useTerminals.getState().patch(id, { unread: false, attention: false });
}

export function writeToTerminal(id: string, text: string): void {
  void ptyWrite(id, text).catch(() => {});
}

/** Types file paths into a terminal the way dropping files on Terminal.app does. */
export function typePaths(id: string, paths: string[]): void {
  writeToTerminal(id, `${paths.map(shellQuotePath).join(" ")} `);
  handles.get(id)?.term.focus();
}

export function searchTerminal(id: string, query: string, direction: "next" | "previous"): boolean {
  const handle = handles.get(id);
  if (!handle || !query) return false;
  const options = { caseSensitive: false, decorations: { matchOverviewRuler: "#3ee6b0", activeMatchColorOverviewRuler: "#ff2a6d", matchBackground: "#0a4a55", activeMatchBackground: "#7a1f3d" } };
  return direction === "next" ? handle.search.findNext(query, options) : handle.search.findPrevious(query, options);
}

export function clearSearch(id: string): void {
  handles.get(id)?.search.clearDecorations();
}

export function restartTerminal(chat: Chat): void {
  const handle = handles.get(chat.id);
  if (!handle) return;
  handle.term.write("\r\n\x1b[2m[restarting…]\x1b[0m\r\n");
  void spawn(chat, handle);
}

export function setTerminalFontSize(size: number): void {
  for (const handle of handles.values()) {
    handle.term.options.fontSize = size;
    try {
      handle.fit.fit();
    } catch {
      /* parked */
    }
  }
}

/** Keeps one live terminal per open terminal session: spawns new ones, ends closed ones. */
function sync(chats: Chat[]): void {
  const live = new Set(activeChats(chats).filter((c) => isTerminalKind(c.kind)).map((c) => c.id));
  for (const id of [...handles.keys()]) if (!live.has(id)) dispose(id);
  for (const chat of activeChats(chats)) {
    if (isTerminalKind(chat.kind) && !handles.has(chat.id)) createHandle(chat);
  }
}

/** Follows `/clear` and `/resume` inside Claude Code so a restart resumes the right session. */
async function trackClaudeSessions(): Promise<void> {
  const chats = activeChats(useChats.getState().chats).filter((c) => c.kind === "claude");
  for (const chat of chats) {
    const handle = handles.get(chat.id);
    if (!handle || !useTerminals.getState().byId[chat.id]?.running) continue;
    const others = chats.filter((c) => c.id !== chat.id && c.cwd === chat.cwd).map((c) => c.claudeSessionId ?? "");
    const latest = await claudeLatestSession(chat.cwd ?? "~", handle.spawnedAt / 1000 - 1, others).catch(() => null);
    if (latest && latest !== chat.claudeSessionId) useChats.getState().setClaudeSession(chat.id, latest);
  }
}

function applyStats(stats: PtyStats[]): void {
  const { byId, patch } = useTerminals.getState();
  for (const s of stats) {
    const current = byId[s.id];
    if (!current) continue;
    if (current.foreground !== s.foreground || current.cpu !== s.cpu || current.memoryMb !== s.memoryMb || current.running !== s.running) {
      patch(s.id, { foreground: s.foreground, cpu: s.cpu, memoryMb: s.memoryMb, running: s.running, exitCode: s.exitCode });
    }
  }
}

let started = false;

/** Starts terminal management once settings are loaded. Safe to call more than once. */
export function startTerminals(): void {
  if (started) return;
  started = true;
  const active = activeChats(useChats.getState().chats).filter((c) => isTerminalKind(c.kind));
  for (const chat of active) restoredAtLaunch.add(chat.id);
  // Which sessions kept running in tmux while E.V was closed — they're reattached, not restarted.
  // tmux sessions whose chat no longer exists (closed elsewhere) are ended.
  void ptyAlive()
    .catch(() => [] as string[])
    .then((alive) => {
      const ids = new Set(active.map((c) => c.id));
      for (const id of alive ?? []) {
        if (ids.has(id)) keptAlive.add(id);
        else void ptyKill(id).catch(() => {});
      }
      startSessions();
    });
}

function startSessions(): void {
  sync(useChats.getState().chats);
  useChats.subscribe((state, previous) => {
    if (state.chats !== previous.chats) sync(state.chats);
    if (state.focusedChatId !== previous.focusedChatId && state.focusedChatId) {
      const runtime = useTerminals.getState().byId[state.focusedChatId];
      if (runtime?.unread || runtime?.attention) useTerminals.getState().patch(state.focusedChatId, { unread: false, attention: false });
    }
  });
  useSettings.subscribe((state, previous) => {
    if (state.settings.terminal.fontSize !== previous.settings.terminal.fontSize) setTerminalFontSize(state.settings.terminal.fontSize);
  });
  window.setInterval(() => void ptyStats().then(applyStats).catch(() => {}), 2000);
  window.setInterval(() => void trackClaudeSessions(), 15_000);
}
