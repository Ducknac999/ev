import { create } from "zustand";
import { claudeUsage, type ClaudeUsage, type UsageWindow } from "../lib/ipc";

interface ClaudeUsageState {
  usage: ClaudeUsage | null;
  error: string | null;
  fetchedAt: number | null;
  loading: boolean;
  refresh: () => Promise<ClaudeUsage | null>;
}

/** The Claude plan's 5-hour and weekly usage, fetched with the CLI's own sign-in. */
export const useClaudeUsage = create<ClaudeUsageState>((set, get) => ({
  usage: null,
  error: null,
  fetchedAt: null,
  loading: false,
  refresh: async () => {
    if (get().loading) return get().usage;
    set({ loading: true });
    try {
      const usage = await claudeUsage();
      set({ usage, error: null, fetchedAt: Date.now(), loading: false });
      return usage;
    } catch (err) {
      set({ error: typeof err === "string" ? err : String(err), loading: false });
      return null;
    }
  },
}));

/** True when a window that had usage rolled over to a fresh one. */
export function windowReset(before: UsageWindow | null, after: UsageWindow | null, now: number): boolean {
  if (!before?.resetsAt || !after || before.utilization <= 0) return false;
  return now >= Date.parse(before.resetsAt) && after.resetsAt !== before.resetsAt;
}
