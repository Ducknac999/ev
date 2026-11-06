import { useTerminals } from "../services/terminals";
import { activeChats, folderName, useChats } from "../store/chats";
import { useLayoutPrefs } from "../store/layoutPrefs";
import { useSessionPanel } from "../store/sessionPanel";
import { useSettings } from "../store/settings";
import type { Chat } from "../types";
import { Icon } from "./Icon";
import { SessionGlyph, sessionLabel, useSessionState } from "./SessionStatus";

function SessionRow({ chat, index }: { chat: Chat; index: number }) {
  const focusedChatId = useChats((s) => s.focusedChatId);
  const layout = useChats((s) => s.layout);
  const { kind, label } = useSessionState(chat);
  const runtime = useTerminals((s) => s.byId[chat.id]);
  const open = () => {
    const store = useChats.getState();
    if (layout === "focus") store.openInFocus(chat.id);
    else {
      if (chat.collapsed) store.setCollapsed(chat.id, false);
      store.focusChat(chat.id);
      document.querySelector(`[data-session-id="${chat.id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  };
  return (
    <button
      className={`side-session status-${kind}${chat.id === focusedChatId ? " active" : ""}`}
      onClick={open}
      title={`${chat.title} · ${sessionLabel(chat)} · ${label}${chat.cwd ? `\n${chat.cwd}` : ""}`}
    >
      <span className="side-index">{index < 9 ? `⌘${index + 1}` : String(index + 1).padStart(2, "0")}</span>
      <SessionGlyph chat={chat} />
      <span className="side-text">
        <span className="side-title">{chat.title}</span>
        <span className="side-meta">
          {chat.kind === "ai" ? sessionLabel(chat) : runtime?.foreground || sessionLabel(chat)}
          {chat.cwd ? ` · ${folderName(chat.cwd)}` : ""}
        </span>
      </span>
      {(runtime?.attention || chat.unseen) && <span className="side-badge attention" title="Needs you" />}
      {!runtime?.attention && runtime?.unread && <span className="side-badge unread" title="New output" />}
      {chat.status === "streaming" && <span className="spinner small" />}
    </button>
  );
}

/** ClaudeDesk-style list of every session, plus recent folders and saved commands. */
export function Sidebar() {
  const open = useLayoutPrefs((s) => s.sidebarOpen);
  const chats = activeChats(useChats((s) => s.chats));
  const settings = useSettings((s) => s.settings);
  const openPanel = useSessionPanel((s) => s.open);
  if (!open) return null;

  const runPreset = (presetId: string) => {
    const preset = settings.terminal.presets.find((p) => p.id === presetId);
    if (!preset) return;
    const id = useChats.getState().createSession(settings, {
      kind: "command",
      command: preset.command,
      cwd: preset.cwd || settings.recentFolders[0] || "~",
      title: preset.name,
    });
    useChats.getState().focusChat(id);
  };

  return (
    <aside className="sidebar" aria-label="Sessions">
      <div className="side-section">
        <div className="side-head">
          <span className="hud-label">Sessions · {chats.length}</span>
          <button className="ctl" title="New session (⌘N)" onClick={() => openPanel({ mode: "new" })}>
            <Icon name="plus" size={12} />
          </button>
        </div>
        <div className="side-list">
          {chats.map((chat, i) => (
            <SessionRow key={chat.id} chat={chat} index={i} />
          ))}
          {chats.length === 0 && <p className="side-empty">No open sessions</p>}
        </div>
      </div>

      <div className="side-section">
        <div className="side-head">
          <span className="hud-label">Folders</span>
        </div>
        <div className="side-list">
          {settings.recentFolders.slice(0, 8).map((folder) => (
            <button
              key={folder}
              className="side-folder"
              title={`${folder}\nClick: new session or resume here`}
              onClick={() => openPanel({ mode: "new", kind: "claude", cwd: folder })}
            >
              <Icon name="folder" size={12} />
              <span className="side-title">{folderName(folder)}</span>
            </button>
          ))}
          {settings.recentFolders.length === 0 && <p className="side-empty">Open a folder to see it here</p>}
        </div>
      </div>

      {settings.terminal.presets.length > 0 && (
        <div className="side-section">
          <div className="side-head">
            <span className="hud-label">Presets</span>
          </div>
          <div className="side-list">
            {settings.terminal.presets.map((preset) => (
              <button key={preset.id} className="side-folder" title={preset.command} onClick={() => runPreset(preset.id)}>
                <Icon name="play" size={11} />
                <span className="side-title">{preset.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
