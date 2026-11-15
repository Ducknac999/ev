import { getCurrentWindow } from "@tauri-apps/api/window";
import type { StateStorage } from "zustand/middleware";
import { chatsLoad, chatsSave } from "../lib/ipc";

/**
 * Where the chat list is kept: a file in E.V's data folder, written crash-safely by the Rust side
 * (chat_store.rs), instead of browser storage. Rules that keep a crash from costing chats:
 * - Only the main window saves; the notch and popups only read.
 * - Nothing is saved until the list has loaded successfully. If loading fails, this run never
 *   saves, so the copy on disk (and its backups) stays as it was.
 * - Saves are coalesced (at most one every 300 ms) and flushed when the window hides or closes.
 */
const SAVE_DELAY_MS = 300;

let loadState: "loading" | "ok" | "failed" = "loading";
let pending: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let readyResolve: (ok: boolean) => void = () => {};

/** Resolves once the chat list has loaded (true) or failed to load (false). */
export const chatsReady: Promise<boolean> = new Promise((resolve) => (readyResolve = resolve));

const isMain = (() => {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return false;
  }
})();

export function chatsLoadFailed(): boolean {
  return loadState === "failed";
}

/** Called by the chats store when loading finished. */
export function markChatsLoaded(ok: boolean): void {
  loadState = ok ? "ok" : "failed";
  readyResolve(ok);
}

/** Writes any waiting change now (e.g. right before a backup). */
export function flushChats(): void {
  flush();
}

function flush(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending === null) return;
  const value = pending;
  pending = null;
  void chatsSave(value).catch((e) => console.warn("Couldn't save the chat list", e));
}

if (isMain && typeof window !== "undefined") {
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}

export const chatFileStorage: StateStorage = {
  async getItem(name) {
    const saved = await chatsLoad();
    if (saved) return saved;
    // First launch with file storage: the list still lives in browser storage. It stays there
    // untouched as one more copy.
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem(_name, value) {
    if (!isMain || loadState !== "ok") return;
    pending = value;
    if (!timer) timer = setTimeout(flush, SAVE_DELAY_MS);
  },
  removeItem() {
    // The chat list is never removed as a whole.
  },
};
