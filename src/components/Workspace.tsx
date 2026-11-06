import { lastPreview, relativeTime } from "../lib/chatStatus";
import { useNow } from "../lib/useNow";
import { activeChats, archivedChats, FOCUS_LIMIT, useChats } from "../store/chats";
import { useSessionPanel } from "../store/sessionPanel";
import type { Chat } from "../types";
import { ChatControls } from "./ChatControls";
import { ChatPane, type PaneVariant } from "./ChatPane";
import { Icon } from "./Icon";
import { SessionGlyph, sessionLabel, SessionStatusPill, useSessionState } from "./SessionStatus";
import { TerminalPane } from "./TerminalPane";
import { BrowserPane } from "./BrowserPane";

const pad = (n: number) => String(n).padStart(2, "0");

function SessionPane(props: { chat: Chat; index: number; focused: boolean; variant: PaneVariant }) {
  if (props.chat.kind === "browser") return <BrowserPane {...props} />;
  return props.chat.kind === "ai" ? <ChatPane {...props} /> : <TerminalPane {...props} />;
}

function EmptyWorkspace({ onOpenClosed }: { onOpenClosed: () => void }) {
  const closedCount = useChats((s) => archivedChats(s.chats).length);
  const open = useSessionPanel((s) => s.open);
  return (
    <div className="workspace-empty">
      <div className="empty-reticle" aria-hidden="true" />
      <div className="hud-label">No active sessions</div>
      <div className="workspace-empty-actions">
        <button className="btn neon" onClick={() => open({ mode: "new", kind: "claude" })}>
          <Icon name="spark" size={14} /> Claude Code
        </button>
        <button className="btn neon" onClick={() => open({ mode: "new", kind: "ai" })}>
          <Icon name="wave" size={14} /> Gemini chat
        </button>
        <button className="btn" onClick={() => open({ mode: "new", kind: "shell" })}>
          <Icon name="terminal" size={14} /> Terminal
        </button>
        <button className="btn" onClick={() => open({ mode: "new" })}>
          <Icon name="plus" size={14} /> New session <kbd>⌘N</kbd>
        </button>
        {closedCount > 0 && (
          <button className="btn" onClick={onOpenClosed}>
            <Icon name="archive" size={13} /> Closed chats ({closedCount})
          </button>
        )}
      </div>
    </div>
  );
}

/** Responsive card matrix: cards never shrink below 360px; the workspace scrolls vertically instead. */
function GridView({ chats, focusedChatId }: { chats: Chat[]; focusedChatId: string | null }) {
  return (
    <div className="workspace-scroll">
      <div className="hud-grid">
        {chats.map((chat, i) => (
          <SessionPane key={chat.id} chat={chat} index={i} focused={chat.id === focusedChatId} variant="card" />
        ))}
      </div>
    </div>
  );
}

function DockItem({ chat, index }: { chat: Chat; index: number }) {
  const openInFocus = useChats((s) => s.openInFocus);
  const { kind } = useSessionState(chat);
  return (
    <button
      className={`dock-item status-${kind}`}
      onClick={() => openInFocus(chat.id)}
      title={`${chat.title} · ${sessionLabel(chat)} — click to bring into focus`}
    >
      <span className="dock-index">{pad(index + 1)}</span>
      <span className="dock-text">
        <span className="dock-title">{chat.title}</span>
        <span className="dock-meta">
          <SessionGlyph chat={chat} /> {sessionLabel(chat)}
        </span>
      </span>
      <span className="status-dot" aria-hidden="true" />
    </button>
  );
}

/** Up to four chats side by side or 2x2; collapsed and background chats wait in the dock. */
function FocusView({ chats, focusedChatId }: { chats: Chat[]; focusedChatId: string | null }) {
  const focusSet = useChats((s) => s.focusSet);
  const expanded = chats.filter((c) => !c.collapsed);
  let focused = focusSet.map((id) => expanded.find((c) => c.id === id)).filter((c): c is Chat => !!c);
  if (focused.length === 0 && expanded.length > 0) {
    focused = [expanded.find((c) => c.id === focusedChatId) ?? expanded[0]];
  }
  const docked = chats.filter((c) => !focused.includes(c));

  return (
    <div className={`focus-layout${docked.length ? "" : " no-dock"}`}>
      {docked.length > 0 && (
        <aside className="focus-dock" aria-label="Background sessions">
          <div className="hud-label dock-head">
            Dock <span className="muted">· {docked.length}</span>
          </div>
          <div className="dock-list">
            {docked.map((chat) => (
              <DockItem key={chat.id} chat={chat} index={chats.indexOf(chat)} />
            ))}
          </div>
        </aside>
      )}
      {focused.length > 0 ? (
        <div className={`focus-grid count-${focused.length}`}>
          {focused.map((chat) => (
            <SessionPane key={chat.id} chat={chat} index={chats.indexOf(chat)} focused={chat.id === focusedChatId} variant="focus" />
          ))}
        </div>
      ) : (
        <div className="focus-placeholder hud-label">All sessions collapsed — pick one from the dock</div>
      )}
      {focused.length >= FOCUS_LIMIT && docked.length > 0 && (
        <div className="focus-hint hud-label">Focus holds {FOCUS_LIMIT} · opening another replaces the oldest</div>
      )}
    </div>
  );
}

/** Command-center rows for managing many sessions at once. */
function TrayView({ chats }: { chats: Chat[] }) {
  const now = useNow();
  const openInFocus = useChats((s) => s.openInFocus);
  const focusChat = useChats((s) => s.focusChat);
  return (
    <div className="workspace-scroll">
      <div className="tray" role="table" aria-label="Sessions">
        <div className="tray-row tray-header" role="row">
          <span role="columnheader">ID</span>
          <span role="columnheader">Session</span>
          <span role="columnheader">Kind</span>
          <span role="columnheader">Updated</span>
          <span role="columnheader">Status</span>
          <span role="columnheader" className="tray-actions-head">
            Controls
          </span>
        </div>
        {chats.map((chat, i) => (
          <div
            key={chat.id}
            className={`tray-row${chat.collapsed ? " is-collapsed" : ""}`}
            role="row"
            onClick={() => focusChat(chat.id)}
            onDoubleClick={() => openInFocus(chat.id)}
          >
            <span className="tray-id" role="cell">
              {pad(i + 1)}
            </span>
            <span className="tray-session" role="cell">
              <span className="tray-title" title={chat.title}>
                {chat.title}
              </span>
              <span className="tray-preview">{chat.collapsed ? "Minimized · " : ""}{lastPreview(chat)}</span>
            </span>
            <span role="cell" className="tray-model">
              <span className="model-tag">
                <SessionGlyph chat={chat} />
                <span className="model-tag-label">{sessionLabel(chat)}</span>
              </span>
            </span>
            <span className="tray-time" role="cell" title={new Date(chat.updatedAt).toLocaleString()}>
              {relativeTime(chat.updatedAt, now)}
            </span>
            <span role="cell">
              <SessionStatusPill chat={chat} />
            </span>
            <span className="tray-actions" role="cell" onClick={(e) => e.stopPropagation()}>
              <button className="btn neon small" onClick={() => openInFocus(chat.id)} title="Open in focus view">
                <Icon name="expand" size={12} /> Focus
              </button>
              <ChatControls chat={chat} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Workspace({ onOpenClosed }: { onOpenClosed: () => void }) {
  const all = useChats((s) => s.chats);
  const layout = useChats((s) => s.layout);
  const focusedChatId = useChats((s) => s.focusedChatId);
  const chats = activeChats(all);

  if (chats.length === 0) return <EmptyWorkspace onOpenClosed={onOpenClosed} />;
  if (layout === "tray") return <TrayView chats={chats} />;
  if (layout === "focus") return <FocusView chats={chats} focusedChatId={focusedChatId} />;
  return <GridView chats={chats} focusedChatId={focusedChatId} />;
}
