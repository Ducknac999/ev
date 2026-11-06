import { useEffect } from "react";
import { relativeTime } from "../lib/chatStatus";
import { useNow } from "../lib/useNow";
import { requestDelete } from "../services/chatLifecycle";
import { archivedChats, useChats } from "../store/chats";
import { Icon } from "./Icon";
import { SessionGlyph, sessionLabel } from "./SessionStatus";

export function ClosedChatsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const chats = useChats((s) => s.chats);
  const restoreChat = useChats((s) => s.restoreChat);
  const pendingDeleteId = useChats((s) => s.pendingDeleteId);
  const closed = archivedChats(chats);
  const now = useNow(30_000);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // The delete confirmation owns Escape while it is open.
      if (e.key === "Escape" && !useChats.getState().pendingDeleteId) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  return (
    <>
      <div className={`drawer-scrim${open ? " open" : ""}`} onPointerDown={() => !pendingDeleteId && onClose()} />
      <aside className={`drawer${open ? " open" : ""}`} aria-label="Closed sessions" aria-hidden={!open} inert={!open}>
        <header className="drawer-head">
          <div>
            <div className="drawer-title">Closed sessions</div>
            <div className="hud-label muted">{closed.length} archived</div>
          </div>
          <button className="icon-btn ghost" onClick={onClose} aria-label="Close drawer">
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="drawer-list">
          {closed.length === 0 && (
            <div className="drawer-empty">
              <div className="hud-label">Archive empty</div>
              <p>Closed terminals and chats with messages land here so you can reopen them. Empty chats are removed immediately.</p>
            </div>
          )}
          {closed.map((chat) => (
            <div key={chat.id} className="drawer-item">
              <div className="drawer-item-main">
                <div className="drawer-item-title" title={chat.title}>
                  {chat.title}
                </div>
                <div className="drawer-item-meta">
                  <SessionGlyph chat={chat} />
                  <span className="truncate">{sessionLabel(chat)}</span>
                  <span className="sep">·</span>
                  <span className="truncate">
                    {chat.kind === "ai"
                      ? `${chat.messages.filter((m) => m.role === "user").length} prompts`
                      : (chat.cwd ?? "~").replace(/^\/Users\/[^/]+/, "~")}
                  </span>
                  <span className="sep">·</span>
                  <span>{relativeTime(chat.archivedAt ?? chat.updatedAt, now)}</span>
                </div>
              </div>
              <button
                className="btn neon small"
                onClick={() => restoreChat(chat.id)}
                title={chat.kind === "claude" ? "Reopen — Claude Code resumes this session" : chat.kind === "ai" ? "Restore to workspace" : "Reopen in a new terminal"}
              >
                <Icon name="restore" size={12} /> {chat.kind === "ai" ? "Restore" : "Reopen"}
              </button>
              <button className="ctl danger" onClick={() => requestDelete(chat.id)} title="Delete permanently" aria-label={`Delete ${chat.title}`}>
                <Icon name="trash" size={12} />
              </button>
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}
