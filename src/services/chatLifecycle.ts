import { attachmentDelete } from "../lib/ipc";
import { useChats } from "../store/chats";
import { useDrafts } from "../store/drafts";
import { useNotice } from "../store/notice";
import { stopGeneration } from "./chatRunner";

/** [x] Close: empty chats vanish, chats with history move to the Closed Chats drawer. */
export function closeChat(id: string): void {
  const chat = useChats.getState().chats.find((c) => c.id === id);
  if (!chat) return;
  stopGeneration(id);
  const outcome = useChats.getState().closeChat(id);
  if (outcome === "archived") {
    useNotice.getState().show({
      message: `“${chat.title}” moved to Closed Chats`,
      actionLabel: "Undo",
      action: () => useChats.getState().restoreChat(id),
    });
  }
}

/** [🗑] Delete: asks for confirmation first; the dialog calls confirmDelete. */
export function requestDelete(id: string): void {
  useChats.getState().requestDelete(id);
}

export function confirmDelete(): void {
  const id = useChats.getState().pendingDeleteId;
  if (!id) return;
  stopGeneration(id);
  const chat = useChats.getState().chats.find((c) => c.id === id);
  const paths = [
    ...(chat?.messages.flatMap((m) => m.attachments ?? []) ?? []),
    ...useDrafts.getState().clear(id),
  ].map((a) => a.path);
  useChats.getState().deleteChat(id);
  // Deleting a chat also removes the files that were attached to it.
  if (paths.length) void attachmentDelete(paths).catch(() => {});
}

export function toggleCollapsed(id: string): void {
  const chat = useChats.getState().chats.find((c) => c.id === id);
  if (chat) useChats.getState().setCollapsed(id, !chat.collapsed);
}
