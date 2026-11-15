import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  backupDeleteAll,
  backupDeletedChat,
  backupForgetDeletedChat,
  backupPasswordSet,
  backupSetPassword,
  backupStatus,
  pickFolder,
  type BackupSnapshot,
  type BackupStatus,
} from "../lib/ipc";
import { backUpNow, restoreBackup } from "../services/backups";
import { useChats } from "../store/chats";
import { BACKUP_MAX_MINUTES, BACKUP_MIN_MINUTES, useSettings } from "../store/settings";
import type { BackupSettings, Chat, Settings } from "../types";

/**
 * Settings → Backups, plus the pieces the setup window shares: how often, and the two choices
 * about what's kept. Backups themselves are plain file copies (src-tauri/src/backup.rs), no AI.
 */

export const EMPTY_BACKUP: BackupSettings = { folder: null, everyMinutes: 0, keepDeleted: false, keepForever: false, includeAgents: true, includeSecrets: false, limitMb: 1024 };
export const BACKUP_FOLDER_PROMPT = "Choose where to keep E.V backups";

/** The backup password: set it once on this Mac; needed only to restore keys from a backup. */
export function SecretsOption({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [editing, setEditing] = useState(false);
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => void backupPasswordSet().then(setHasPassword, () => setHasPassword(false)), []);

  const save = async () => {
    if (first.length < 8) return setError("Use at least 8 characters.");
    if (first !== second) return setError("The two passwords don't match.");
    setBusy(true);
    setError("");
    try {
      await backupSetPassword(first);
      setHasPassword(true);
      setEditing(false);
      setFirst("");
      setSecond("");
      onChange(true);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const showForm = editing || (on && hasPassword === false);
  return (
    <div className={`backup-choice${on ? " on" : ""}`}>
      <input
        type="checkbox"
        checked={on}
        aria-label="Include API keys and the memory key"
        onChange={(e) => {
          if (!e.target.checked) return onChange(false);
          if (hasPassword) onChange(true);
          else setEditing(true);
        }}
      />
      <span>
        <strong>Include API keys and the memory key, locked with a password</strong>
        <span>
          Lets a restore bring back your API keys, memory and schedules — even on a new Mac. They're locked with a backup password you make, so
          nobody who opens the folder can use them. You'll type the password only when restoring. If you forget it, the keys can't be recovered
          from the backup (you'd make new ones); everything else still restores.
        </span>
        {hasPassword && !showForm && (
          <span className="backup-secret-row">
            Backup password is set on this Mac.
            <button className="btn" onClick={() => setEditing(true)}>
              Change password
            </button>
          </span>
        )}
        {showForm && (
          <span className="backup-password">
            <input type="password" placeholder="Backup password (8+ characters)" value={first} onChange={(e) => setFirst(e.target.value)} autoFocus />
            <input type="password" placeholder="Type it again" value={second} onChange={(e) => setSecond(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
            <span className="backup-secret-row">
              <button className="btn primary" disabled={busy} onClick={() => void save()}>
                {busy ? "Saving…" : "Set password"}
              </button>
              <button className="btn ghost" onClick={() => (setEditing(false), setError(""), setFirst(""), setSecond(""), !hasPassword && onChange(false))}>
                Cancel
              </button>
            </span>
            {error && <span className="error-text">{error}</span>}
          </span>
        )}
      </span>
    </div>
  );
}

const PRESETS: { minutes: number; label: string }[] = [
  { minutes: 0, label: "Off" },
  { minutes: 60, label: "Every hour" },
  { minutes: 360, label: "Every 6 hours" },
  { minutes: 1440, label: "Every day" },
  { minutes: 4320, label: "Every 3 days" },
  { minutes: 10080, label: "Every week" },
];

const UNITS = [
  { id: "minutes", label: "minutes", factor: 1 },
  { id: "hours", label: "hours", factor: 60 },
  { id: "days", label: "days", factor: 1440 },
] as const;

const LIMITS = [
  { mb: 500, label: "500 MB" },
  { mb: 1024, label: "1 GB" },
  { mb: 2048, label: "2 GB" },
  { mb: 5120, label: "5 GB" },
  { mb: 10240, label: "10 GB" },
  { mb: 0, label: "No limit" },
];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatWhen(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" })} ${time}`;
}

export function describeEvery(minutes: number): string {
  if (minutes <= 0) return "Off";
  const preset = PRESETS.find((p) => p.minutes === minutes);
  if (preset) return preset.label;
  if (minutes % 1440 === 0) return `Every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

/** Off, the common choices, or your own number of minutes, hours or days (15 minutes to 30 days). */
export function IntervalPicker({ minutes, onChange }: { minutes: number; onChange: (minutes: number) => void }) {
  const isPreset = PRESETS.some((p) => p.minutes === minutes);
  const [custom, setCustom] = useState(!isPreset);
  const unit = UNITS.slice().reverse().find((u) => minutes > 0 && minutes % u.factor === 0) ?? UNITS[0];
  const [amount, setAmount] = useState(String(minutes > 0 ? minutes / unit.factor : 30));
  const [unitId, setUnitId] = useState<(typeof UNITS)[number]["id"]>(minutes > 0 ? unit.id : "minutes");

  const applyCustom = (value: string, id: (typeof UNITS)[number]["id"]) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return;
    const factor = UNITS.find((u) => u.id === id)!.factor;
    onChange(Math.min(BACKUP_MAX_MINUTES, Math.max(BACKUP_MIN_MINUTES, Math.round(n * factor))));
  };

  return (
    <div className="backup-interval">
      <div className="backup-chips" role="radiogroup" aria-label="How often">
        {PRESETS.map((p) => (
          <button
            key={p.minutes}
            role="radio"
            aria-checked={!custom && minutes === p.minutes}
            className={`backup-chip${!custom && minutes === p.minutes ? " on" : ""}`}
            onClick={() => (setCustom(false), onChange(p.minutes))}
          >
            {p.label}
          </button>
        ))}
        <button role="radio" aria-checked={custom} className={`backup-chip${custom ? " on" : ""}`} onClick={() => (setCustom(true), applyCustom(amount, unitId))}>
          Custom
        </button>
      </div>
      {custom && (
        <div className="backup-custom">
          <span>Every</span>
          <input
            type="number"
            min={1}
            value={amount}
            aria-label="Amount"
            onChange={(e) => (setAmount(e.target.value), applyCustom(e.target.value, unitId))}
          />
          <select
            value={unitId}
            aria-label="Unit"
            onChange={(e) => {
              const id = e.target.value as (typeof UNITS)[number]["id"];
              setUnitId(id);
              applyCustom(amount, id);
            }}
          >
            {UNITS.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
          <span className="backup-hint">{minutes > 0 ? `= ${describeEvery(minutes).toLowerCase()}` : ""} · 15 minutes to 30 days</span>
        </div>
      )}
      <p className="backup-hint">Backups run only while E.V is open. If one is overdue when you open E.V, it runs right away; quitting E.V takes one more.</p>
    </div>
  );
}

/** The two choices about what's kept, explained. Nothing is ticked until you pick. */
export function BackupChoices({ keepDeleted, keepForever, onChange }: { keepDeleted: boolean; keepForever: boolean; onChange: (next: { keepDeleted: boolean; keepForever: boolean }) => void }) {
  return (
    <div className="backup-choices">
      <label className={`backup-choice${keepDeleted ? " on" : ""}`}>
        <input type="checkbox" checked={keepDeleted} onChange={(e) => onChange({ keepDeleted: e.target.checked, keepForever })} />
        <span>
          <strong>Keep deleted chats in the backup</strong>
          <span>If you delete a chat, a copy stays in your backup and you can bring it back later. Uses very little space.</span>
        </span>
      </label>
      <label className={`backup-choice${keepForever ? " on" : ""}`}>
        <input type="checkbox" checked={keepForever} onChange={(e) => onChange({ keepDeleted, keepForever: e.target.checked })} />
        <span>
          <strong>Never delete old backups</strong>
          <span>
            Every backup is kept forever, so you can go back to any day — but the folder keeps growing. Left off, older backups thin out: everything from the
            last day, one a day for a week, one a week for a month. The newest backup always has all your chats, old ones included.
          </span>
        </span>
      </label>
    </div>
  );
}

/** Folder, how often, choices and size limit: edits the Settings draft (saved with Save). */
export function BackupOptions({ draft, update }: { draft: Settings; update: (fn: (d: Settings) => void) => void }) {
  const b = draft.backup ?? EMPTY_BACKUP;
  const set = (fn: (b: BackupSettings) => void) =>
    update((d) => {
      const next = { ...(d.backup ?? EMPTY_BACKUP) };
      fn(next);
      d.backup = next;
    });
  const choose = async () => {
    const folder = await pickFolder(b.folder ?? "~/Documents", BACKUP_FOLDER_PROMPT).catch(() => null);
    if (folder) set((n) => void (n.folder = folder.replace(/\/$/, "")));
  };

  return (
    <div className="settings-card">
      <h4>Backups</h4>
      <p className="settings-intro">
        In case anything goes wrong, E.V keeps copies of your chats, attached files, layout, settings and connections in a folder you pick — and, if you like,
        your Claude Code and Codex conversations. Only what changed is copied (a conversation that grew adds just its new part), and every copy is read back
        to check it. Text packs down a lot; pictures inside conversations don't. No AI, no tokens. API keys go in only if you choose, locked with a password.
      </p>
      <div className="field">
        <span>Backup folder</span>
        <div className="backup-folder">
          <code>{b.folder ? `${b.folder.replace(/\/E\.V Backups$/, "")}/E.V Backups` : "Not chosen — backups are off"}</code>
          <button className="btn" onClick={() => void choose()}>
            {b.folder ? "Change…" : "Choose…"}
          </button>
        </div>
        <span className="backup-hint">On this Mac protects you if E.V breaks. An external drive or iCloud Drive also survives the Mac itself.</span>
      </div>
      <div className="field">
        <span>How often</span>
        <IntervalPicker minutes={b.everyMinutes} onChange={(m) => set((n) => void (n.everyMinutes = m))} />
      </div>
      <BackupChoices keepDeleted={b.keepDeleted} keepForever={b.keepForever} onChange={(c) => set((n) => Object.assign(n, c))} />
      <label className="check-row">
        <input type="checkbox" checked={b.includeAgents} onChange={(e) => set((n) => void (n.includeAgents = e.target.checked))} />
        <span>Include Claude Code and Codex conversations (only new or changed parts are copied each time)</span>
      </label>
      <SecretsOption on={b.includeSecrets} onChange={(on) => set((n) => void (n.includeSecrets = on))} />
      <label className="field">
        <span>Most space backups may use</span>
        <select value={b.keepForever ? 0 : b.limitMb} disabled={b.keepForever} onChange={(e) => set((n) => void (n.limitMb = Number(e.target.value)))}>
          {LIMITS.map((l) => (
            <option key={l.mb} value={l.mb}>
              {l.label}
            </option>
          ))}
        </select>
        <span className="backup-hint">
          {b.keepForever
            ? "Off while “Never delete old backups” is on."
            : "When backups reach this, the oldest go first. The newest backup and your deleted chats are never removed."}
        </span>
      </label>
    </div>
  );
}

function Confirm({
  title,
  body,
  action,
  danger,
  onCancel,
  onConfirm,
  children,
}: {
  title: string;
  body: string;
  action: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className={`modal${danger ? " modal-danger" : ""}`} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body">
        <h3 id="confirm-title">{title}</h3>
        <p id="confirm-body">{body}</p>
        {children}
        <div className="modal-actions">
          <button ref={cancelRef} className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className={`btn ${danger ? "danger" : "primary"}`} onClick={onConfirm}>
            {action}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A deleted chat goes back into the Closed Chats drawer. */
function bringBack(chat: Chat): void {
  useChats.setState((s) => {
    if (s.chats.some((c) => c.id === chat.id)) return {};
    const restored: Chat = { ...chat, messages: chat.messages ?? [], status: "idle", paused: null, archived: true, archivedAt: Date.now() };
    return { chats: [...s.chats, restored] };
  });
}

/** What's in the backup folder now, and what you can do with it (uses the saved settings). */
export function BackupList({ draft }: { draft: Settings }) {
  const saved = useSettings((s) => s.settings.backup);
  const folder = saved?.folder ?? null;
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState<{ kind: "restore"; snap: BackupSnapshot } | { kind: "delete" } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [password, setPassword] = useState("");

  const refresh = useCallback(() => {
    if (!folder) return setStatus(null);
    void backupStatus(folder).then(setStatus, (e) => setMessage(String(e)));
  }, [folder]);
  useEffect(refresh, [refresh]);

  if (!folder) {
    return (
      <div className="settings-card">
        <h4>Your backups</h4>
        <p className="settings-intro">No backup folder yet. Choose one above and press Save.</p>
      </div>
    );
  }

  const run = async () => {
    setBusy("now");
    setMessage("");
    try {
      const r = await backUpNow();
      setMessage(r.saved ? `Backed up — ${r.newFiles} new or changed file${r.newFiles === 1 ? "" : "s"} (${formatBytes(r.bytesAdded)}).` : "Nothing changed since the last backup.");
    } catch (e) {
      setMessage(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const restore = async (snap: BackupSnapshot) => {
    setConfirm(null);
    setBusy(snap.id);
    setMessage("Restoring… E.V will restart.");
    try {
      await restoreBackup(folder, snap.id, password || null);
    } catch (e) {
      setMessage(`Couldn't restore: ${String(e instanceof Error ? e.message : e)}. Nothing was changed.`);
      setBusy(null);
    }
  };

  const deleteAll = async () => {
    setConfirm(null);
    try {
      await backupDeleteAll(folder);
      setMessage("All backups were deleted.");
    } catch (e) {
      setMessage(String(e instanceof Error ? e.message : e));
    }
    refresh();
  };

  const recover = async (id: string) => {
    try {
      const chat = JSON.parse(await backupDeletedChat(folder, id)) as Chat;
      bringBack(chat);
      await backupForgetDeletedChat(folder, id);
      setMessage(`“${chat.title}” is back — find it in Closed Chats.`);
    } catch (e) {
      setMessage(String(e instanceof Error ? e.message : e));
    }
    refresh();
  };

  const snaps = status?.snapshots ?? [];
  const shown = showAll ? snaps : snaps.slice(0, 8);
  const moved = draft.backup?.folder !== folder;

  return (
    <>
      <div className="settings-card">
        <h4>Your backups</h4>
        {moved && <p className="backup-hint">You changed the folder — press Save to use it.</p>}
        <div className="backup-stats">
          <div>
            <span>Last backup</span>
            <strong>{status?.lastRun ? formatWhen(status.lastRun) : "Not yet"}</strong>
          </div>
          <div>
            <span>How often</span>
            <strong>{describeEvery(saved?.everyMinutes ?? 0)}</strong>
          </div>
          <div>
            <span>Space used</span>
            <strong>{status ? formatBytes(status.totalBytes) : "…"}</strong>
          </div>
          <div>
            <span>Backups</span>
            <strong>{snaps.length}</strong>
          </div>
        </div>
        <code className="backup-path">{status?.root ?? folder}</code>
        <div className="backup-actions">
          <button className="btn primary" disabled={busy !== null} onClick={() => void run()}>
            {busy === "now" ? "Backing up…" : "Back up now"}
          </button>
          <span className="pane-spacer" />
          <button className="btn danger" disabled={busy !== null || snaps.length === 0} onClick={() => setConfirm({ kind: "delete" })}>
            Clean up now
          </button>
        </div>
        {message && <p className="backup-message">{message}</p>}
        {snaps.length > 0 && (
          <>
            <ul className="backup-list">
              {shown.map((s, i) => (
                <li key={s.id}>
                  <div>
                    <strong>{formatWhen(s.at)}</strong>
                    {i === 0 && <span className="backup-tag">Newest</span>}
                    <span className="backup-hint">
                      {s.chats} chat{s.chats === 1 ? "" : "s"} · E.V {s.appVersion}
                      {s.hasSecrets ? " · keys locked inside" : ""}
                    </span>
                  </div>
                  <button className="btn" disabled={busy !== null} onClick={() => (setPassword(""), setConfirm({ kind: "restore", snap: s }))}>
                    {busy === s.id ? "Restoring…" : "Restore"}
                  </button>
                </li>
              ))}
            </ul>
            {snaps.length > shown.length && (
              <button className="btn ghost" onClick={() => setShowAll(true)}>
                Show all {snaps.length}
              </button>
            )}
          </>
        )}
      </div>
      {(status?.deletedChats.length ?? 0) > 0 && (
        <div className="settings-card">
          <h4>Deleted chats kept in the backup</h4>
          <ul className="backup-list">
            {status!.deletedChats.map((c) => (
              <li key={c.id}>
                <div>
                  <strong>{c.title}</strong>
                  <span className="backup-hint">Deleted {formatWhen(c.deletedAt)}</span>
                </div>
                <button className="btn" onClick={() => void recover(c.id)}>
                  Bring back
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {confirm?.kind === "restore" && (
        <Confirm
          title={`Restore the backup from ${formatWhen(confirm.snap.at)}?`}
          body={`E.V first saves a backup of how things are right now (so you can undo this), then puts your chats, attached files, layout, settings and connections back as they were at that time and restarts. Claude Code and Codex conversations are only added back, never cut short. ${
            confirm.snap.hasSecrets
              ? "This backup has your API keys and memory key locked inside: type your backup password to bring them back too, or leave it empty to keep today's keys."
              : "Your API keys stay as they are now."
          }`}
          action="Restore"
          onCancel={() => setConfirm(null)}
          onConfirm={() => void restore(confirm.snap)}
        >
          {confirm.snap.hasSecrets && (
            <input
              className="backup-restore-password"
              type="password"
              placeholder="Backup password (optional)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void restore(confirm.snap)}
            />
          )}
        </Confirm>
      )}
      {confirm?.kind === "delete" && (
        <Confirm
          danger
          title="Delete all backups?"
          body="Doing so removes every backup in “E.V Backups”, deleted chats included. You can't get them back."
          action="Delete"
          onCancel={() => setConfirm(null)}
          onConfirm={() => void deleteAll()}
        />
      )}
    </>
  );
}
