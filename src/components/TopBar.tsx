
import { exitTalkMode } from "../services/voiceControl";
import { openBrowserPanel } from "../services/browserPanel";
import { activeChats, archivedChats, useChats } from "../store/chats";
import { useVoice } from "../store/voice";
import type { Chat, LayoutMode } from "../types";
import { Icon, type IconName } from "./Icon";
import { SessionGlyph, sessionLabel } from "./SessionStatus";
import { useSessionPanel } from "../store/sessionPanel";
import { useLayoutPrefs } from "../store/layoutPrefs";

const LAYOUTS: { id: LayoutMode; icon: IconName; label: string; short: string }[] = [
  { id: "hud", icon: "hud", label: "Compact HUD grid", short: "Grid" },
  { id: "focus", icon: "focus", label: "Focus / split screen (up to 4)", short: "Focus" },
  { id: "tray", icon: "rows", label: "Tray list — command center", short: "Tray" },
];

function TaskBadge({ chat }: { chat: Chat }) {
  const restore = () => useChats.getState().setCollapsed(chat.id, false);
  const state = chat.status === "streaming" ? "running" : chat.status === "error" ? "error" : chat.unseen ? "done" : "idle";
  const stateLabel = { running: "Running", error: "Failed", done: "Finished", idle: "Idle" }[state];
  return (
    <button
      className={`task-badge state-${state}`}
      onClick={restore}
      title={`${chat.title} — ${sessionLabel(chat)} · ${stateLabel}. Click to expand.`}
    >
      {state === "running" ? (
        <span className="spinner small" />
      ) : state === "done" ? (
        <Icon name="check" size={12} />
      ) : state === "error" ? (
        <Icon name="alert" size={12} />
      ) : (
        <SessionGlyph chat={chat} />
      )}
      <span className="task-badge-title">{chat.title}</span>
      {chat.paused && <Icon name="pause" size={11} className="muted" />}
    </button>
  );
}

export function TopBar({ onOpenSettings, onOpenClosed }: { onOpenSettings: () => void; onOpenClosed: () => void }) {
  const all = useChats((s) => s.chats);
  const chats = activeChats(all);
  const closedCount = archivedChats(all).length;
  const layout = useChats((s) => s.layout);
  const setLayout = useChats((s) => s.setLayout);
  const openPanel = useSessionPanel((s) => s.open);
  const sidebarOpen = useLayoutPrefs((s) => s.sidebarOpen);
  const toggleSidebar = useLayoutPrefs((s) => s.toggleSidebar);
  const talkChatId = useVoice((s) => s.talkChatId);
  const listen = useVoice((s) => s.listen);
  const speaking = useVoice((s) => s.speaking);
  const talkChat = all.find((c) => c.id === talkChatId);
  const minimized = chats.filter((c) => c.collapsed);
  const running = minimized.filter((c) => c.status === "streaming").length;

  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="topbar-left" data-tauri-drag-region>
      <button
        className={`icon-btn sidebar-toggle${sidebarOpen ? " on" : ""}`}
        onClick={toggleSidebar}
        title="Sessions sidebar (⌘B)"
        aria-pressed={sidebarOpen}
      >
        <Icon name="sidebar" />
      </button>
      <div className="brand" data-tauri-drag-region>
        <span className="brand-mark" aria-hidden="true" />
        E.V
      </div>

      <div className="task-tray" data-tauri-drag-region aria-label="Active tasks">
        {minimized.length > 0 && (
          <span className="task-tray-label" data-tauri-drag-region>
            Tasks{running > 0 ? ` · ${running} running` : ""}
          </span>
        )}
        {minimized.map((chat) => (
          <TaskBadge key={chat.id} chat={chat} />
        ))}
      </div>
      </div>

      {talkChat && (
        <div className={`talk-pill state-${speaking ? "speaking" : listen}`}>
          <button className="talk-pill-main" onClick={() => useChats.getState().focusChat(talkChat.id)} title="Go to the chat that has the microphone">
            <Icon name="mic" size={13} />
            <span>
              Talking to: <b>{talkChat.title}</b>
            </span>
          </button>
          <button className="talk-pill-stop" onClick={exitTalkMode} title="Stop talking (⌘⇧T)" aria-label="Stop talking">
            <Icon name="close" size={11} />
          </button>
        </div>
      )}

      <div className="topbar-controls">
        <div className="segmented" role="group" aria-label="Layout">
          {LAYOUTS.map((l) => (
            <button
              key={l.id}
              className={layout === l.id ? "active" : ""}
              onClick={() => setLayout(l.id)}
              title={`${l.label} (⌘\\ to cycle)`}
              aria-pressed={layout === l.id}
            >
              <Icon name={l.icon} size={13} />
              <span className="seg-label">{l.short}</span>
            </button>
          ))}
        </div>

        <button
          className={`btn closed-btn${closedCount ? "" : " empty"}`}
          onClick={onOpenClosed}
          title="Closed sessions (⌘⇧A)"
          aria-label={`Closed sessions (${closedCount})`}
        >
          <Icon name="archive" size={13} /> <span className="btn-label">Closed</span>
          <span className="count">{closedCount}</span>
        </button>
        <button className="icon-btn" onClick={() => openBrowserPanel()} title="E.V Browser — browse here; your tabs stay private unless you share them">
          <Icon name="globe" />
        </button>
        <button className="btn neon" onClick={() => openPanel({ mode: "new" })} title="New session (⌘N) · Terminal (⌘T)">
          <Icon name="plus" size={14} /> <span className="btn-label">New</span>
        </button>
        <button className="icon-btn" onClick={onOpenSettings} title="Settings (⌘,)">
          <Icon name="settings" />
        </button>
      </div>
    </header>
  );
}
