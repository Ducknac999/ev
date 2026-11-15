import { backupConfigure, backupRestart, backupRestore, backupRun, backupStatus, type BackupConfig, type BackupRunReport } from "../lib/ipc";
import { flushChats } from "../store/chatStorage";
import { useSettings } from "../store/settings";
import type { BackupSettings } from "../types";

/**
 * Timed backups while E.V is open (src-tauri/src/backup.rs does the copying; no AI involved).
 * Checked every minute: when the chosen time has passed since the last backup, one runs. Opening
 * E.V after a long break runs one straight away if it's overdue, and quitting takes one more.
 */

const CHECK_MS = 60_000;
/** Chats live in their own file; this old browser copy is skipped. */
const SKIP_KEYS = new Set(["gideon.workspace"]);

let lastRun = 0;
let lastFolder: string | null = null;
let running = false;
let started = false;

export function backupConfig(b: BackupSettings | undefined): BackupConfig | null {
  if (!b?.folder) return null;
  return {
    folder: b.folder,
    keepDeleted: b.keepDeleted,
    keepForever: b.keepForever,
    includeAgents: b.includeAgents,
    includeSecrets: b.includeSecrets,
    limitMb: b.keepForever ? 0 : b.limitMb,
  };
}

/** The window's own saved preferences (layout, drafts, picks), as one JSON text. */
export function localState(): string | null {
  try {
    const all: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && !SKIP_KEYS.has(key)) all[key] = localStorage.getItem(key) ?? "";
    }
    return JSON.stringify(all);
  } catch {
    return null;
  }
}

/** Puts the saved preferences from a backup back (keys not in it are left alone). */
export function writeLocalState(text: string | null): void {
  if (!text) return;
  try {
    const all = JSON.parse(text) as Record<string, string>;
    for (const [key, value] of Object.entries(all)) {
      if (!SKIP_KEYS.has(key)) localStorage.setItem(key, value);
    }
  } catch {
    /* a backup without readable preferences: chats and settings are still restored */
  }
}

/** Takes a backup now with the saved settings. */
export async function backUpNow(): Promise<BackupRunReport> {
  const config = backupConfig(useSettings.getState().settings.backup);
  if (!config) throw new Error("Choose a backup folder first.");
  if (running) throw new Error("A backup is already running.");
  running = true;
  try {
    flushChats();
    // Let the chat file write land first.
    await new Promise((r) => setTimeout(r, 400));
    const report = await backupRun(config, localState());
    lastRun = report.at;
    return report;
  } finally {
    running = false;
  }
}

async function tick(): Promise<void> {
  const b = useSettings.getState().settings.backup;
  const config = backupConfig(b);
  void backupConfigure(config && b && b.everyMinutes > 0 ? config : null).catch(() => {});
  if (!config || !b || b.everyMinutes <= 0 || running) return;
  if (config.folder !== lastFolder) {
    lastFolder = config.folder;
    lastRun = await backupStatus(config.folder).then((s) => s.lastRun, () => 0);
  }
  if (Date.now() - lastRun < b.everyMinutes * 60_000) return;
  await backUpNow().catch((e) => console.warn("Backup failed", e));
}

export function startBackups(): void {
  if (started) return;
  started = true;
  // A little after opening, so starting up isn't slowed down.
  window.setTimeout(() => void tick(), 20_000);
  window.setInterval(() => void tick(), CHECK_MS);
  useSettings.subscribe((state, previous) => {
    if (state.settings.backup !== previous.settings.backup) void tick();
  });
}

/**
 * Puts a backup back and restarts E.V. A backup of how things are right now is taken first, so
 * this can be undone by restoring that one.
 */
export async function restoreBackup(folder: string, id: string, password: string | null = null): Promise<void> {
  const b = useSettings.getState().settings.backup;
  const config = backupConfig(
    b && b.folder === folder ? b : { folder, everyMinutes: 0, keepDeleted: false, keepForever: true, includeAgents: true, includeSecrets: false, limitMb: 0 },
  );
  if (!config) throw new Error("No backup folder.");
  flushChats();
  await new Promise((r) => setTimeout(r, 400));
  const local = await backupRestore(config, id, localState(), password);
  writeLocalState(local);
  await backupRestart();
}
