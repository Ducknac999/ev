import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { TokenUsage } from "../providers/agent/adapters";

/**
 * What E.V's AI use costs: tokens per day (and how many came from the provider's cache, billed at a
 * fraction of the price), plus DeepSeek's real account balance — so "spent today" is what the
 * account actually lost, not an estimate from a price list.
 */

export interface DayUsage {
  day: string;
  input: number;
  cached: number;
  output: number;
  requests: number;
}

interface UsageState {
  today: DayUsage;
  /** DeepSeek balance, last read. */
  balance: { amount: number; currency: string; at: number } | null;
  /** Balance at the start of today (raised by top-ups made today). */
  dayStart: { day: string; amount: number } | null;
  /** The day the user chose to go past the daily limit. */
  pastLimitDay: string | null;
  /** The day E.V already warned at 80% of the limit. */
  warnedDay: string | null;
  add: (usage: TokenUsage) => void;
  setBalance: (amount: number, currency: string) => void;
  allowPastLimit: () => void;
  markWarned: () => void;
}

export function dayKey(at = new Date()): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

const empty = (day = dayKey()): DayUsage => ({ day, input: 0, cached: 0, output: 0, requests: 0 });

export const useUsage = create<UsageState>()(
  persist(
    (set, get) => ({
      today: empty(),
      balance: null,
      dayStart: null,
      pastLimitDay: null,
      warnedDay: null,
      add: (usage) => {
        const day = dayKey();
        const today = get().today.day === day ? get().today : empty(day);
        set({ today: { day, input: today.input + usage.input, cached: today.cached + usage.cached, output: today.output + usage.output, requests: today.requests + 1 } });
      },
      setBalance: (amount, currency) => {
        const day = dayKey();
        const { balance, dayStart } = get();
        let start = dayStart?.day === day ? dayStart.amount : (balance && dayKey(new Date(balance.at)) === day ? balance.amount : amount);
        // Topped up today: the new money isn't "spent" in reverse.
        if (balance && dayKey(new Date(balance.at)) === day && amount > balance.amount) start += amount - balance.amount;
        set({ balance: { amount, currency, at: Date.now() }, dayStart: { day, amount: start } });
      },
      allowPastLimit: () => set({ pastLimitDay: dayKey() }),
      markWarned: () => set({ warnedDay: dayKey() }),
    }),
    { name: "ev.usage" },
  ),
);

/** Money spent today on DeepSeek, from the balance (null until it has been read twice today). */
export function spentToday(): number | null {
  const { balance, dayStart } = useUsage.getState();
  const day = dayKey();
  if (!balance || !dayStart || dayStart.day !== day || dayKey(new Date(balance.at)) !== day) return null;
  return Math.max(0, dayStart.amount - balance.amount);
}

/** Today's counts (zero if the last use was another day). */
export function todayUsage(): DayUsage {
  const { today } = useUsage.getState();
  return today.day === dayKey() ? today : empty();
}

/** "12.4k" */
export function shortCount(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}
