import { useEffect, useMemo, useState } from "react";
import { relativeTime } from "../lib/chatStatus";
import { claudeSessions, pickFolder, type ClaudeSessionInfo } from "../lib/ipc";
import { modelLabel } from "../providers/catalog";
import { folderName, useChats } from "../store/chats";
import { useSessionPanel } from "../store/sessionPanel";
import { useSettings } from "../store/settings";
import type { SessionKind } from "../types";
import { Icon, type IconName } from "./Icon";

const ALL_KINDS: { kind: SessionKind; label: string; icon: IconName; hint: string }[] = [
  { kind: "claude", label: "Claude Code", icon: "spark", hint: "Real Claude Code in a project folder" },
  { kind: "codex", label: "Codex", icon: "spark", hint: "OpenAI's Codex in a project folder" },
  { kind: "ai", label: "E.V Chat", icon: "wave", hint: "Chat that can work on your Mac with approvals" },
  { kind: "shell", label: "Terminal", icon: "terminal", hint: "Your normal Mac terminal" },
  { kind: "command", label: "Command", icon: "play", hint: "Run one command in its own tab" },
];

const tilde = (path: string) => path.replace(/^\/Users\/[^/]+/, "~");

/** New session / open folder / resume dialog — ClaudeDesk's folder workflow inside E.V. */
export function SessionPanel() {
  const request = useSessionPanel((s) => s.request);
  const close = useSessionPanel((s) => s.close);
  const settings = useSettings((s) => s.settings);
  const chats = useChats((s) => s.chats);
  const [kind, setKind] = useState<SessionKind>("claude");
  // Coding agents the user chose in the start window (Claude Code, Codex or both).
  const KINDS = ALL_KINDS.filter((k) => (k.kind !== "claude" || settings.agents.claude) && (k.kind !== "codex" || settings.agents.codex));
  const [cwd, setCwd] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [past, setPast] = useState<ClaudeSessionInfo[] | null>(null);
  const [filter, setFilter] = useState("");
  const now = Date.now();

  useEffect(() => {
    if (!request) return;
    setKind(request.kind ?? "claude");
    setCwd(request.cwd ?? settings.recentFolders[0] ?? null);
    setCommand("");
    setFilter("");
  }, [request, settings.recentFolders]);

  useEffect(() => {
    setPast(null);
    if (!request || kind !== "claude" || !cwd) return;
    let cancelled = false;
    claudeSessions(cwd).then(
      (list) => !cancelled && setPast(list),
      () => !cancelled && setPast([]),
    );
    return () => {
      cancelled = true;
    };
  }, [request, kind, cwd]);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [request, close]);

  const geminiChats = useMemo(
    () => (cwd ? chats.filter((c) => c.kind === "ai" && c.cwd === cwd).sort((a, b) => b.updatedAt - a.updatedAt) : []),
    [chats, cwd],
  );

  if (!request) return null;

  const browse = async () => {
    const picked = await pickFolder(cwd ?? undefined).catch(() => null);
    if (picked) setCwd(picked.replace(/\/$/, "") || "/");
  };

  const start = (claudeSessionId?: string) => {
    const folder = cwd ?? "~";
    if (kind === "command" && !command.trim()) return;
    const id = useChats.getState().createSession(settings, {
      kind,
      cwd: folder,
      command: kind === "command" ? command.trim() : undefined,
      claudeSessionId,
    });
    if (cwd) useSettings.getState().rememberFolder(cwd);
    useChats.getState().focusChat(id);
    close();
  };

  const openChat = (id: string) => {
    const chat = chats.find((c) => c.id === id);
    if (chat?.archived) useChats.getState().restoreChat(id);
    else useChats.getState().focusChat(id);
    close();
  };

  const recent = settings.recentFolders;
  const shownPast = (past ?? []).filter((s) => !filter || s.title.toLowerCase().includes(filter.toLowerCase()));
  const needsFolder = kind === "claude" || kind === "codex" || kind === "ai";
  const canStart = (!needsFolder || !!cwd) && (kind !== "command" || !!command.trim());

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="session-panel" role="dialog" aria-modal="true" aria-label="New session">
        <header className="session-panel-head">
          <h3>{request.mode === "resume" ? "Resume Claude Code" : "New session"}</h3>
          <button className="icon-btn ghost" onClick={close} aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </header>

        {request.mode === "new" && (
          <div className="kind-grid" role="radiogroup" aria-label="Session kind">
            {KINDS.map((k) => (
              <button
                key={k.kind}
                role="radio"
                aria-checked={kind === k.kind}
                className={`kind-card${kind === k.kind ? " selected" : ""}`}
                onClick={() => setKind(k.kind)}
              >
                <Icon name={k.icon} size={16} />
                <span className="kind-card-label">{k.label}</span>
                <span className="kind-card-hint">{k.hint}</span>
              </button>
            ))}
          </div>
        )}

        <div className="session-panel-body">
          <section className="folder-col" aria-label="Project folder">
            <div className="hud-label">Project folder{needsFolder ? "" : " (optional)"}</div>
            <button className="btn neon folder-browse" onClick={() => void browse()}>
              <Icon name="folder" size={13} /> Choose folder…
            </button>
            {!needsFolder && (
              <button className={`folder-row${cwd === null ? " selected" : ""}`} onClick={() => setCwd(null)}>
                <Icon name="folder" size={12} /> <span className="folder-row-name">Home</span>
                <span className="folder-row-path">~</span>
              </button>
            )}
            {cwd && !recent.includes(cwd) && (
              <button className="folder-row selected" title={cwd}>
                <Icon name="folder" size={12} /> <span className="folder-row-name">{folderName(cwd)}</span>
                <span className="folder-row-path">{tilde(cwd)}</span>
              </button>
            )}
            {recent.map((folder) => (
              <button
                key={folder}
                className={`folder-row${cwd === folder ? " selected" : ""}`}
                onClick={() => setCwd(folder)}
                onDoubleClick={() => {
                  setCwd(folder);
                  if (kind !== "command") start();
                }}
                title={folder}
              >
                <Icon name="folder" size={12} /> <span className="folder-row-name">{folderName(folder)}</span>
                <span className="folder-row-path">{tilde(folder)}</span>
              </button>
            ))}
            {recent.length === 0 && !cwd && <p className="muted small">Folders you open appear here.</p>}
          </section>

          <section className="detail-col">
            {kind === "command" && (
              <label className="field">
                <span>Command</span>
                <input
                  className="mono"
                  autoFocus
                  placeholder="e.g. npm run dev"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && canStart && start()}
                />
              </label>
            )}
            {kind === "command" && settings.terminal.presets.length > 0 && (
              <div className="preset-list">
                <div className="hud-label">Presets</div>
                {settings.terminal.presets.map((p) => (
                  <button
                    key={p.id}
                    className="folder-row"
                    onClick={() => {
                      setCommand(p.command);
                      if (p.cwd) setCwd(p.cwd);
                    }}
                    title={p.command}
                  >
                    <Icon name="play" size={11} /> <span className="folder-row-name">{p.name}</span>
                    <span className="folder-row-path">{p.command}</span>
                  </button>
                ))}
              </div>
            )}

            <button className="btn primary start-btn" disabled={!canStart} onClick={() => start()}>
              <Icon name="plus" size={13} />{" "}
              {kind === "claude" ? "New Claude Code session" : kind === "codex" ? "New Codex session" : kind === "ai" ? "New E.V Chat" : kind === "shell" ? "Open terminal" : "Run command"}
              {cwd && needsFolder ? ` in ${folderName(cwd)}` : ""}
            </button>

            {kind === "claude" && cwd && (
              <div className="past-list">
                <div className="past-head">
                  <span className="hud-label">Resume · past sessions in {folderName(cwd)}</span>
                  {(past?.length ?? 0) > 6 && (
                    <input className="past-filter" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
                  )}
                </div>
                {past === null && <p className="muted small">Loading…</p>}
                {past?.length === 0 && <p className="muted small">No Claude Code sessions in this folder yet.</p>}
                {shownPast.slice(0, 60).map((s) => (
                  <button key={s.id} className="past-row" onClick={() => start(s.id)} title={`Resume ${s.id}`}>
                    <span className="past-title">{s.title}</span>
                    <span className="past-meta">
                      {relativeTime(s.modified * 1000, now)} · {Math.max(1, Math.round(s.size / 1024))} KB
                    </span>
                    <span className="past-action">
                      <Icon name="history" size={11} /> Resume
                    </span>
                  </button>
                ))}
              </div>
            )}

            {kind === "ai" && cwd && geminiChats.length > 0 && (
              <div className="past-list">
                <div className="past-head">
                  <span className="hud-label">Chats in {folderName(cwd)}</span>
                </div>
                {geminiChats.slice(0, 40).map((c) => (
                  <button key={c.id} className="past-row" onClick={() => openChat(c.id)}>
                    <span className="past-title">{c.title}</span>
                    <span className="past-meta">
                      {modelLabel(c.model)} · {relativeTime(c.updatedAt, now)}
                      {c.archived ? " · closed" : ""}
                    </span>
                    <span className="past-action">
                      <Icon name="restore" size={11} /> Open
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
