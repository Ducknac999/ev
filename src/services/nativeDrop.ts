import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useChats } from "../store/chats";
import { useDrafts } from "../store/drafts";
import { useDropTarget } from "../store/dropTarget";
import { typePaths } from "./terminals";

function sessionAt(x: number, y: number): string | null {
  const scale = window.devicePixelRatio || 1;
  const element = document.elementFromPoint(x / scale, y / scale);
  return (element?.closest("[data-session-id]") as HTMLElement | null)?.dataset.sessionId ?? null;
}

/**
 * Files dragged in from Finder: AI chats attach them, terminals get their paths typed in —
 * the same thing dropping a file on Terminal.app does.
 */
export async function startNativeDrop(): Promise<void> {
  await getCurrentWebview().onDragDropEvent(({ payload }) => {
    const target = useDropTarget.getState();
    if (payload.type === "leave") {
      target.set(null);
      return;
    }
    const id = sessionAt(payload.position.x, payload.position.y);
    const chat = id ? useChats.getState().chats.find((c) => c.id === id) : undefined;
    const accepts = !!chat && !chat.paused && !chat.collapsed;
    if (payload.type === "enter" || payload.type === "over") {
      target.set(accepts ? id : null);
      return;
    }
    target.set(null);
    if (!accepts || !chat || payload.paths.length === 0) return;
    if (chat.kind === "ai") useDrafts.getState().addPaths(chat.id, payload.paths);
    else typePaths(chat.id, payload.paths);
    useChats.getState().focusChat(chat.id);
  });
}
