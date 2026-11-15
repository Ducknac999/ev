import { create } from "zustand";
import type { Page } from "../components/settingsSearch";

/** Windows other parts of E.V can open: Settings at a page (and card), and "What's new". */
interface UiState {
  settingsAt: { page: Page; anchor?: string } | null;
  whatsNewOpen: boolean;
}

export const useUi = create<UiState>(() => ({ settingsAt: null, whatsNewOpen: false }));

export const openSettingsAt = (page: Page, anchor?: string) => useUi.setState({ settingsAt: { page, anchor } });
export const openWhatsNew = () => useUi.setState({ whatsNewOpen: true });
