import { create } from "zustand";
import type { SessionKind } from "../types";

export interface SessionPanelRequest {
  /** new: choose kind + folder · resume: past Claude Code sessions for a folder. */
  mode: "new" | "resume";
  kind?: SessionKind;
  cwd?: string;
}

interface SessionPanelState {
  request: SessionPanelRequest | null;
  open: (request: SessionPanelRequest) => void;
  close: () => void;
}

/** The "new session / open folder / resume" dialog. */
export const useSessionPanel = create<SessionPanelState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));
