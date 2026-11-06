import type { KeyView } from "../providers/keyPool";

export type UsageTone = "ok" | "warn" | "bad";

/** Colour band for a bar: green while plenty is left, amber when low, red when (nearly) out. */
export function toneFor(usedFraction: number): UsageTone {
  if (usedFraction >= 0.9) return "bad";
  if (usedFraction >= 0.6) return "warn";
  return "ok";
}

const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function sameLocalDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** "in 42s" / "in 18m" for near resets, "10:29 PM" later today, "Wed 4:59 PM" beyond. */
export function formatReset(ts: number, now: number): string {
  const diff = ts - now;
  if (diff <= 0) return "now";
  if (diff < 60_000) return `in ${Math.ceil(diff / 1000)}s`;
  if (diff < 60 * 60_000) return `in ${Math.ceil(diff / 60_000)}m`;
  if (sameLocalDay(ts, now)) return time(ts);
  const day = new Date(ts).toLocaleDateString([], { weekday: "short" });
  return `${day} ${time(ts)}`;
}

export const formatCount = (n: number) => n.toLocaleString();

/** One-line state of a key, e.g. "in use · Chat 2", "used up · resets 12:00 AM". */
export function keyStatusText(view: KeyView, titleOf: (chatId: string) => string, now: number): string {
  switch (view.status) {
    case "in-use":
      return `in use · ${view.usedBy.map(titleOf).join(", ")}`;
    case "ready":
      return "free";
    case "cooling":
      return `rate limited · ${view.until ? formatReset(view.until, now) : "briefly"}`;
    case "exhausted":
      return `used up · resets ${view.until ? formatReset(view.until, now) : "tomorrow"}`;
    case "unavailable":
      return "model not on free tier";
    case "invalid":
      return "rejected — check key";
  }
}

/** "182/250 left" style summary, or the raw request count when no limit is known. */
export function remainingText(view: Pick<KeyView, "used" | "limit" | "remaining">): string {
  if (view.limit === null || view.remaining === null) return `${formatCount(view.used)} used today`;
  return `${formatCount(view.remaining)}/${formatCount(view.limit)} left`;
}
