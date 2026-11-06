import { create } from "zustand";
import { useChats } from "../store/chats";
import { useSettings } from "../store/settings";

/** Which E.V Browser tab the Browser panel shows. */
export const useBrowserView = create<{ tab: string | null; setTab: (tab: string | null) => void }>((set) => ({
  tab: null,
  setTab: (tab) => set({ tab }),
}));

/**
 * Opens (or focuses) the one Browser panel, showing `tab` when given — e.g. the Desmos graph the AI
 * just made, or the page it was asked to show.
 */
export function openBrowserPanel(tab?: string): void {
  const store = useChats.getState();
  const existing = store.chats.find((c) => c.kind === "browser" && !c.archived);
  const id = existing?.id ?? store.createSession(useSettings.getState().settings, { kind: "browser" });
  if (existing?.collapsed) store.setCollapsed(existing.id, false);
  store.focusChat(id);
  if (tab) useBrowserView.getState().setTab(tab);
}
