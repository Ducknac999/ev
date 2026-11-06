import { chatStatus } from "../lib/chatStatus";
import type { Chat } from "../types";

export function StatusPill({ chat }: { chat: Chat }) {
  const { kind, label } = chatStatus(chat);
  return (
    <span className={`status-pill status-${kind}`} role="status">
      <span className="status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
