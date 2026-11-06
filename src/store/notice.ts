import { create } from "zustand";

export interface Notice {
  id: number;
  message: string;
  actionLabel?: string;
  action?: () => void;
}

interface NoticeState {
  notice: Notice | null;
  show: (notice: Omit<Notice, "id">) => void;
  dismiss: () => void;
}

let counter = 0;

/** Transient confirmation toasts (e.g. "Moved to Closed Chats · Undo"). */
export const useNotice = create<NoticeState>((set) => ({
  notice: null,
  show: (notice) => set({ notice: { ...notice, id: ++counter } }),
  dismiss: () => set({ notice: null }),
}));
