import { create } from "zustand";
import { formatBytes, mimeFromName, prepareAttachment, prepareBytes } from "../lib/attachments";
import { uid } from "../lib/ids";
import { attachmentDelete, readDroppedFile } from "../lib/ipc";
import type { Attachment } from "../types";

export const MAX_ATTACHMENTS = 10;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface DraftItem {
  id: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "error";
  attachment?: Attachment;
  error?: string;
}

interface DraftsState {
  /** Files attached to each chat's composer but not sent yet. */
  byChat: Record<string, DraftItem[]>;
  add: (chatId: string, files: File[]) => void;
  /** Files dropped from Finder, which arrive as paths. */
  addPaths: (chatId: string, paths: string[]) => void;
  remove: (chatId: string, itemId: string) => void;
  /** Hands the ready attachments to a message being sent and empties the draft. */
  take: (chatId: string) => Attachment[];
  /** Empties the draft, returning attachments whose files the caller should delete. */
  clear: (chatId: string) => Attachment[];
}

const readyOf = (items: DraftItem[] = []) =>
  items.filter((i) => i.status === "ready" && i.attachment).map((i) => i.attachment!);

export const useDrafts = create<DraftsState>((set, get) => {
  const patch = (chatId: string, itemId: string, change: Partial<DraftItem>) =>
    set((s) => ({
      byChat: { ...s.byChat, [chatId]: (s.byChat[chatId] ?? []).map((i) => (i.id === itemId ? { ...i, ...change } : i)) },
    }));

  return {
    byChat: {},

    add: (chatId, files) => {
      const room = MAX_ATTACHMENTS - (get().byChat[chatId]?.length ?? 0);
      const accepted = files.slice(0, Math.max(0, room));
      const items: DraftItem[] = accepted.map((file) => ({
        id: uid("draft-"),
        name: file.name || "pasted file",
        size: file.size,
        status: file.size > MAX_FILE_BYTES ? "error" : "uploading",
        error: file.size > MAX_FILE_BYTES ? `Too large (${formatBytes(file.size)}, max 50 MB)` : undefined,
      }));
      const rejected: DraftItem[] = files.slice(accepted.length).map((file) => ({
        id: uid("draft-"),
        name: file.name || "file",
        size: file.size,
        status: "error",
        error: `Only ${MAX_ATTACHMENTS} files per message`,
      }));
      set((s) => ({ byChat: { ...s.byChat, [chatId]: [...(s.byChat[chatId] ?? []), ...items, ...rejected] } }));

      accepted.forEach((file, i) => {
        const item = items[i];
        if (item.status === "error") return;
        prepareAttachment(file).then(
          (attachment) => {
            // The draft may have been removed or sent while the file was being stored.
            if (!get().byChat[chatId]?.some((d) => d.id === item.id)) {
              void attachmentDelete([attachment.path]).catch(() => {});
              return;
            }
            patch(chatId, item.id, { status: "ready", attachment, name: attachment.name, size: attachment.size });
          },
          (err) => patch(chatId, item.id, { status: "error", error: `Could not attach: ${String(err)}` }),
        );
      });
    },

    addPaths: (chatId, paths) => {
      const room = MAX_ATTACHMENTS - (get().byChat[chatId]?.length ?? 0);
      const accepted = paths.slice(0, Math.max(0, room));
      const items: DraftItem[] = accepted.map((path) => ({ id: uid("draft-"), name: path.split("/").pop() || "file", size: 0, status: "uploading" }));
      const rejected: DraftItem[] = paths.slice(accepted.length).map((path) => ({
        id: uid("draft-"),
        name: path.split("/").pop() || "file",
        size: 0,
        status: "error",
        error: `Only ${MAX_ATTACHMENTS} files per message`,
      }));
      set((s) => ({ byChat: { ...s.byChat, [chatId]: [...(s.byChat[chatId] ?? []), ...items, ...rejected] } }));
      accepted.forEach((path, i) => {
        const item = items[i];
        readDroppedFile(path)
          .then((buffer) => {
            if (buffer.byteLength > MAX_FILE_BYTES) throw new Error(`Too large (${formatBytes(buffer.byteLength)}, max 50 MB)`);
            return prepareBytes(new Uint8Array(buffer), item.name, mimeFromName(item.name));
          })
          .then(
            (attachment) => {
              if (!get().byChat[chatId]?.some((d) => d.id === item.id)) {
                void attachmentDelete([attachment.path]).catch(() => {});
                return;
              }
              patch(chatId, item.id, { status: "ready", attachment, name: attachment.name, size: attachment.size });
            },
            (err) => patch(chatId, item.id, { status: "error", error: err instanceof Error ? err.message : `Could not attach: ${String(err)}` }),
          );
      });
    },

    remove: (chatId, itemId) => {
      const item = get().byChat[chatId]?.find((i) => i.id === itemId);
      set((s) => ({ byChat: { ...s.byChat, [chatId]: (s.byChat[chatId] ?? []).filter((i) => i.id !== itemId) } }));
      if (item?.attachment) void attachmentDelete([item.attachment.path]).catch(() => {});
    },

    take: (chatId) => {
      const ready = readyOf(get().byChat[chatId]);
      set((s) => ({ byChat: { ...s.byChat, [chatId]: [] } }));
      return ready;
    },

    clear: (chatId) => {
      const ready = readyOf(get().byChat[chatId]);
      set((s) => {
        const { [chatId]: _removed, ...rest } = s.byChat;
        return { byChat: rest };
      });
      return ready;
    },
  };
});
