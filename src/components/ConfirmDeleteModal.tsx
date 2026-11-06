import { useEffect, useRef } from "react";
import { confirmDelete } from "../services/chatLifecycle";
import { useChats } from "../store/chats";

export function ConfirmDeleteModal() {
  const pendingId = useChats((s) => s.pendingDeleteId);
  const chat = useChats((s) => s.chats.find((c) => c.id === s.pendingDeleteId));
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!pendingId) return;
    // Safe default: focus lands on Cancel, so a stray Enter never deletes.
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        useChats.getState().cancelDelete();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pendingId]);

  if (!pendingId || !chat) return null;
  const cancel = () => useChats.getState().cancelDelete();

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && cancel()}>
      <div className="modal modal-danger" role="alertdialog" aria-modal="true" aria-labelledby="del-title" aria-describedby="del-desc">
        <h3 id="del-title">Delete chat?</h3>
        <div className="modal-subject" title={chat.title}>
          {chat.title}
        </div>
        <p id="del-desc">This will permanently clear this conversation from history and cannot be undone.</p>
        <div className="modal-actions">
          <button ref={cancelRef} className="btn" onClick={cancel}>
            Cancel
          </button>
          <button className="btn danger" onClick={confirmDelete}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
