import { useEffect, useRef } from "react";
import { modelLabel, pickFallback, PROVIDERS } from "../providers/catalog";
import { stopGeneration } from "../services/chatRunner";
import { useChats } from "../store/chats";
import { useSettings } from "../store/settings";

export function LockConflictModal() {
  const conflict = useChats((s) => s.conflict);
  const chats = useChats((s) => s.chats);
  const settings = useSettings((s) => s.settings);
  const primaryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!conflict) return;
    primaryRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        useChats.getState().dismissConflict();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [conflict]);

  if (!conflict) return null;
  const holder = chats.find((c) => c.id === conflict.holderChatId);
  const requester = chats.find((c) => c.id === conflict.requestingChatId);
  if (!holder || !requester) return null;

  const fallback = pickFallback(settings);
  const holderBusy = holder.status === "streaming";

  const transfer = () => {
    const pausedId = useChats.getState().resolveConflictTransfer();
    if (pausedId) stopGeneration(pausedId);
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && useChats.getState().dismissConflict()}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="lock-title">
        <h3 id="lock-title">{PROVIDERS[conflict.model.provider].label} is in use</h3>
        <p>
          <strong>{modelLabel(conflict.model)}</strong> is an exclusive model and is currently assigned to{" "}
          <strong>{holder.title}</strong>
          {holderBusy ? ", which is generating a reply right now" : ""}. It can only serve one active chat at a time.
        </p>
        <div className="modal-choices">
          <button ref={primaryRef} className="choice danger" onClick={transfer}>
            <span className="choice-title">Pause {holder.title} &amp; transfer model</span>
            <span className="choice-desc">
              {holder.title} becomes read-only{holderBusy ? " and its current reply stops" : ""}. {requester.title} gets{" "}
              {modelLabel(conflict.model)}.
            </span>
          </button>
          <button className="choice" onClick={() => useChats.getState().resolveConflictFallback(settings)}>
            <span className="choice-title">Keep {holder.title} &amp; use fallback</span>
            <span className="choice-desc">
              {requester.title} switches to {modelLabel(fallback)}, which runs concurrently.
            </span>
          </button>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={() => useChats.getState().dismissConflict()}>
            Cancel <kbd>Esc</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
