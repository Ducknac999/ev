import { create } from "zustand";

/** Session a Finder drag is currently hovering, for the drop overlay. */
export const useDropTarget = create<{ targetId: string | null; set: (id: string | null) => void }>((set) => ({
  targetId: null,
  set: (targetId) => set({ targetId }),
}));
