import { calendarSync, showNotification } from "../lib/ipc";
import { announceImportant } from "./announce";
import { formatInstant, parseInstant } from "../providers/agent/liveTools";
import { useNotice } from "../store/notice";
import { useSettings } from "../store/settings";
import { useVault } from "../store/vault";
import type { Repeat, ScheduleItem } from "../types";

/** Schedules the user added themselves; reminders fire only while E.V is open. */

export interface Occurrence {
  event: ScheduleItem;
  at: number;
}

const DAY = 86_400_000;

function wallParts(start: string): { y: number; m: number; d: number; time: string } {
  const [date, time = "00:00"] = start.split(/[T ]/);
  const [y, m, d] = date.split("-").map(Number);
  return { y, m, d, time };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The n-th repetition's wall-clock date, or null when that month has no such day (e.g. Feb 30). */
function nthWallDate(start: string, repeat: Repeat, n: number): string | null {
  const { y, m, d, time } = wallParts(start);
  const base = new Date(Date.UTC(y, m - 1, d));
  let date: Date;
  switch (repeat) {
    case "daily":
    case "weekdays":
      date = new Date(base.getTime() + n * DAY);
      break;
    case "weekly":
      date = new Date(base.getTime() + n * 7 * DAY);
      break;
    case "monthly":
      date = new Date(Date.UTC(y, m - 1 + n, d));
      if (date.getUTCDate() !== d) return null;
      break;
    case "yearly":
      date = new Date(Date.UTC(y + n, m - 1, d));
      if (date.getUTCDate() !== d) return null;
      break;
    default:
      if (n > 0) return null;
      date = base;
  }
  if (repeat === "weekdays" && (date.getUTCDay() === 0 || date.getUTCDay() === 6)) return "skip";
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${time}`;
}

/** Every occurrence of `event` between `from` and `to` (epoch ms), in order. */
export function occurrences(event: ScheduleItem, from: number, to: number): Occurrence[] {
  const out: Occurrence[] = [];
  const until = event.until ? parseInstant(`${event.until} 23:59`, event.timeZone) : Infinity;
  for (let n = 0; n < 5000; n++) {
    const wall = nthWallDate(event.start, event.repeat, n);
    if (wall === null) {
      if (event.repeat === "none") break;
      continue;
    }
    if (wall === "skip") continue;
    const at = parseInstant(wall, event.timeZone);
    if (at > to || at > until) break;
    if (at >= from) out.push({ event, at });
    if (event.repeat === "none") break;
  }
  return out;
}

export function upcoming(events: ScheduleItem[], from: number, to: number): Occurrence[] {
  return events.flatMap((e) => occurrences(e, from, to)).sort((a, b) => a.at - b.at);
}

const REPEAT_WORDS: Record<Repeat, string> = {
  none: "",
  daily: "every day",
  weekdays: "every weekday",
  weekly: "every week",
  monthly: "every month",
  yearly: "every year",
};

/** e.g. "Gym · Sat, Oct 10, 2026, 6:00 PM PDT · every week". */
export function describeEvent(event: ScheduleItem, at?: number): string {
  const when = formatInstant(at ?? parseInstant(event.start, event.timeZone), event.timeZone);
  return [event.title, when, REPEAT_WORDS[event.repeat]].filter(Boolean).join(" · ");
}

// ── Reminders ─────────────────────────────────────────────────────────────────

const TICK_MS = 20_000;
/** A reminder missed by more than this (E.V was closed) is skipped, not shown late. */
const GRACE_MS = 2 * 60_000;

function remind(occurrence: Occurrence, early: boolean, lead: number): void {
  const { event, at } = occurrence;
  const time = new Intl.DateTimeFormat("en-US", { timeZone: event.timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(at));
  const body = early ? `In ${lead} minutes, at ${time}` : `Now · ${time}`;
  void showNotification(`E.V · ${event.title}`, body).catch(() => {});
  useNotice.getState().show({ message: `${event.title} — ${early ? `in ${lead} minutes (${time})` : `now (${time})`}` });
  // Never silent: out loud (music paused) and in the notch, whatever the chat's settings.
  void announceImportant(early ? `Reminder: ${event.title}, in ${lead} minutes, at ${time}.` : `Reminder: ${event.title}, now.`);
}

/** "Math class, today, Thursday November 6th, at 2 PM, in 28 minutes." — said back when one is set. */
export function readBack(event: ScheduleItem, now = Date.now()): string {
  const at = parseInstant(event.start, event.timeZone, now);
  const zone = event.timeZone;
  const dayKey = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
  const relative = dayKey(at) === dayKey(now) ? "today, " : dayKey(at) === dayKey(now + 86_400_000) ? "tomorrow, " : "";
  const date = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", month: "long", day: "numeric" }).format(new Date(at));
  const time = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(new Date(at)).replace(":00", "");
  const mins = Math.round((at - now) / 60_000);
  const until = mins < 0 ? "That time has already passed" : mins < 60 ? `In ${mins} minute${mins === 1 ? "" : "s"}` : mins < 24 * 60 ? `In ${Math.round(mins / 60)} hour${Math.round(mins / 60) === 1 ? "" : "s"}` : "";
  const repeat = event.repeat !== "none" ? `, every ${{ daily: "day", weekdays: "weekday", weekly: "week", monthly: "month", yearly: "year" }[event.repeat as string] ?? event.repeat}` : "";
  return `${event.title}: ${relative}${date}, at ${time}${repeat}.${until ? ` ${until}.` : ""}`;
}

/** Mirrors a reminder into the Mac's Calendar (or removes it), so macOS rings it even when E.V is closed. */
export function syncToCalendar(action: "upsert" | "delete", event: ScheduleItem): void {
  const lead = useSettings.getState().settings.reminders.leadMinutes;
  const until = event.until ? parseInstant(`${event.until} 23:59`, event.timeZone) : undefined;
  const repeat = event.repeat === "weekdays" ? "daily" : event.repeat;
  void calendarSync(
    action === "delete"
      ? { action, id: event.id }
      : { action, id: event.id, title: event.title, start: parseInstant(event.start, event.timeZone), minutes: 30, notes: event.notes ?? "Set by E.V", repeat, until, lead },
  ).catch((err) => useNotice.getState().show({ message: `Couldn't put “${event.title}” in Calendar: ${String(err)}` }));
}

const CHECKED_KEY = "ev.remindersCheckedAt";

/** Reminders that came due while E.V was closed: told once, as soon as it opens. */
function tellMissed(now: number): void {
  const last = Number(globalThis.localStorage?.getItem(CHECKED_KEY)) || now;
  const { schedule, fired, markFired, loaded } = useVault.getState();
  if (!loaded) return;
  const firedSet = new Set(fired);
  const missed = upcoming(schedule, last, now - GRACE_MS).filter((o) => !firedSet.has(`${o.event.id}@${o.at}:start`));
  for (const o of missed) markFired(`${o.event.id}@${o.at}:start`);
  if (!missed.length) return;
  const list = missed
    .slice(0, 3)
    .map((o) => `${o.event.title} at ${new Intl.DateTimeFormat("en-US", { timeZone: o.event.timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(o.at))}`)
    .join(", ");
  void announceImportant(`While E.V was closed, you missed: ${list}${missed.length > 3 ? `, and ${missed.length - 3} more` : ""}.`);
}

export function checkReminders(now = Date.now()): void {
  globalThis.localStorage?.setItem(CHECKED_KEY, String(now));
  const { schedule, fired, markFired, loaded } = useVault.getState();
  if (!loaded || !schedule.length) return;
  const lead = useSettings.getState().settings.reminders.leadMinutes;
  const firedSet = new Set(fired);
  for (const occurrence of upcoming(schedule, now - GRACE_MS, now + lead * 60_000 + TICK_MS)) {
    const marks: [string, number, boolean][] = [[`${occurrence.event.id}@${occurrence.at}:start`, occurrence.at, false]];
    if (lead > 0) marks.unshift([`${occurrence.event.id}@${occurrence.at}:early`, occurrence.at - lead * 60_000, true]);
    for (const [key, due, early] of marks) {
      if (firedSet.has(key) || due > now || now - due > GRACE_MS) continue;
      markFired(key);
      firedSet.add(key);
      remind(occurrence, early, lead);
    }
  }
}

let started = false;

export function startReminders(): void {
  if (started) return;
  started = true;
  tellMissed(Date.now());
  checkReminders();
  window.setInterval(() => checkReminders(), TICK_MS);
}
