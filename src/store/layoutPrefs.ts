import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface LayoutPrefs {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
}

/** Per-machine UI preferences that aren't part of Settings. */
export const useLayoutPrefs = create<LayoutPrefs>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
    }),
    { name: "gideon.layout", storage: createJSONStorage(() => localStorage) },
  ),
);
