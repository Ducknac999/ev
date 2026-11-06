import { emitTo, listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import type { PopupAnswer, PopupItem } from "../services/approvalPopup";

/** The approval popup window (top right, over any app): one row per waiting approval. */
export function ApprovalPopup() {
  const [list, setList] = useState<PopupItem[]>([]);
  useEffect(() => {
    document.documentElement.classList.add("popup-root");
    const off = listen<PopupItem[]>("approval-items", (event) => setList(event.payload));
    void off.then(() => emitTo("main", "approval-popup-ready")).catch(() => {});
    return () => void off.then((f) => f()).catch(() => {});
  }, []);
  const send = (approvalId: string, answer: PopupAnswer["answer"]) => {
    setList((l) => l.filter((i) => i.approvalId !== approvalId));
    void emitTo("main", "approval-answer", { approvalId, answer } satisfies PopupAnswer).catch(() => {});
  };
  return (
    <div className="approval-popup" role="alertdialog" aria-label="E.V needs your approval">
      {list.map((item, i) => (
        <div key={item.approvalId} className={`approval-pop-row${item.final ? " final" : ""}`}>
          <div className="approval-pop-head">
            <span className="approval-pop-brand">E.V</span>
            <span className="approval-pop-chat">{item.chatTitle}</span>
            {i === 0 && <span className="approval-pop-keys">{item.keys}</span>}
          </div>
          <div className="approval-pop-titles">
            {item.titles.slice(0, 3).map((t, j) => (
              <div key={j} className="approval-pop-title">
                {t}
              </div>
            ))}
            {item.titles.length > 3 && <div className="approval-pop-more">+{item.titles.length - 3} more</div>}
          </div>
          <div className="approval-pop-actions">
            {item.final && <span className="approval-pop-warn">Can't be taken back</span>}
            <button className="btn small deny" onClick={() => send(item.approvalId, "deny")}>
              {item.final ? "Don't" : "Deny"}
            </button>
            {item.always && (
              <button className="btn small approve-always" title={`From now on: ${item.always}`} onClick={() => send(item.approvalId, "always")}>
                Always
              </button>
            )}
            <button className="btn small approve" onClick={() => send(item.approvalId, "approve")}>
              {item.plan ? "Approve plan" : item.final ? (item.titles[0]?.startsWith("Delete") ? "Delete now" : "Send now") : item.titles.length > 1 ? `Approve all ${item.titles.length}` : "Approve"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
