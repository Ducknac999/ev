import { closeChat, requestDelete, toggleCollapsed } from "../services/chatLifecycle";
import { useChats } from "../store/chats";
import type { Chat } from "../types";
import { Icon } from "./Icon";

/**
 * The three lifecycle controls shared by cards and tray rows, plus an optional
 * focus/dock toggle: [−] collapse · [x] close/archive · [🗑] delete.
 */
export function ChatControls({ chat, focusAction }: { chat: Chat; focusAction?: "expand" | "dock" }) {
  const { openInFocus, removeFromFocus } = useChats.getState();
  return (
    <div className="chat-controls" onDoubleClick={(e) => e.stopPropagation()}>
      {focusAction === "expand" && (
        <button className="ctl" title="Expand into focus view" aria-label="Expand into focus view" onClick={() => openInFocus(chat.id)}>
          <Icon name="expand" size={12} />
        </button>
      )}
      {focusAction === "dock" && (
        <button className="ctl" title="Send to dock" aria-label="Send to dock" onClick={() => removeFromFocus(chat.id)}>
          <Icon name="dock" size={12} />
        </button>
      )}
      <button
        className="ctl"
        title={chat.collapsed ? "Expand chat (⌘⇧M)" : "Minimize — collapse in place (⌘⇧M)"}
        aria-label={chat.collapsed ? "Expand chat" : "Minimize chat"}
        aria-pressed={chat.collapsed}
        onClick={() => toggleCollapsed(chat.id)}
      >
        <Icon name={chat.collapsed ? "plus" : "minimize"} size={12} />
      </button>
      <button
        className="ctl"
        title={chat.messages.length ? "Close — move to Closed Chats (⌘⇧W)" : "Close — empty chat is removed (⌘⇧W)"}
        aria-label="Close chat"
        onClick={() => closeChat(chat.id)}
      >
        <Icon name="close" size={12} />
      </button>
      <button className="ctl danger" title="Delete permanently (⌘⇧⌫)" aria-label="Delete chat" onClick={() => requestDelete(chat.id)}>
        <Icon name="trash" size={12} />
      </button>
    </div>
  );
}
