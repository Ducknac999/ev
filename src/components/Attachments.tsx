import { formatBytes } from "../lib/attachments";
import { attachmentOpen } from "../lib/ipc";
import type { DraftItem } from "../store/drafts";
import type { Attachment } from "../types";
import { Icon } from "./Icon";

const open = (a: Attachment) => void attachmentOpen(a.path).catch(() => {});

function kindLabel(a: Attachment): string {
  return a.kind === "binary" ? a.name.split(".").pop()?.toUpperCase() || "FILE" : a.kind.toUpperCase();
}

/** Files shown on a sent message; click opens E.V's copy in its default app. */
export function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  return (
    <div className="msg-attachments">
      {attachments.map((a) =>
        a.preview ? (
          <button key={a.id} className="att-thumb" onClick={() => open(a)} title={`${a.name} · ${formatBytes(a.size)} — click to open`}>
            <img src={a.preview} alt={a.name} />
          </button>
        ) : (
          <button key={a.id} className="att-chip" onClick={() => open(a)} title={`${a.name} — click to open`}>
            <Icon name="file" size={14} />
            <span className="att-name">{a.name}</span>
            <span className="att-meta">
              {kindLabel(a)} · {formatBytes(a.size)}
            </span>
          </button>
        ),
      )}
    </div>
  );
}

/** Pending files above the composer, each removable before sending. */
export function DraftAttachments({
  items,
  problems,
  onRemove,
}: {
  items: DraftItem[];
  problems: Map<string, string>;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="draft-attachments">
      {items.map((item) => {
        const problem = item.error ?? problems.get(item.id);
        return (
          <div
            key={item.id}
            className={`att-chip draft status-${item.status}${problem ? " problem" : ""}`}
            title={problem ?? `${item.name} · ${formatBytes(item.size)}`}
          >
            {item.attachment?.preview ? (
              <img className="att-mini" src={item.attachment.preview} alt="" />
            ) : item.status === "uploading" ? (
              <span className="spinner" />
            ) : (
              <Icon name={problem ? "alert" : "file"} size={14} />
            )}
            <span className="att-name">{item.name}</span>
            <span className="att-meta">{item.status === "uploading" ? "attaching…" : problem ? "can't send" : formatBytes(item.size)}</span>
            <button className="att-remove" onClick={() => onRemove(item.id)} aria-label={`Remove ${item.name}`} title="Remove">
              <Icon name="close" size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
