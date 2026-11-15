import type { Page } from "./components/settingsSearch";
import { newer } from "./lib/version";

/**
 * The "What's new" window's content, newest first. Each release: a few cards (one per bigger
 * change, with a picture and a "Show me" that opens the place in E.V) and a list of smaller fixes.
 * Pictures are drawn by WhatsNew.tsx from made-up example content, never a real chat.
 */

export type WhatsNewTag = "Safety" | "Security" | "New" | "Voice" | "Look" | "Notch" | "Fix";
export type WhatsNewPicture = "restored" | "backups" | "deleted" | "secrets" | "whatsnew";

export interface WhatsNewCard {
  tag: WhatsNewTag;
  title: string;
  text: string;
  picture: WhatsNewPicture;
  show?: { page: Page; anchor?: string };
}

export interface WhatsNewRelease {
  version: string;
  date: string;
  cards: WhatsNewCard[];
  smaller: string[];
}

export const WHATS_NEW: WhatsNewRelease[] = [
  {
    version: "1.0.8",
    date: "2026-11-13",
    cards: [
      {
        tag: "Safety",
        title: "A crash can't lose your chats anymore",
        text: "If E.V ever closes unexpectedly, your chats, layout and running Claude Code, Codex and terminal sessions come back exactly as they were. E.V tells you when it restored things.",
        picture: "restored",
      },
      {
        tag: "New",
        title: "Backups to a folder you pick",
        text: "Choose a folder and how often — every hour, every day, every week or your own time. Chats, attached files, settings and Claude Code / Codex conversations; only what changed is copied and checked. No AI, no tokens. Restore any backup in one click.",
        picture: "backups",
        show: { page: "backups", anchor: "backups" },
      },
      {
        tag: "New",
        title: "Bring back a deleted chat",
        text: "Turn on “Keep deleted chats in the backup”, and a chat you delete can come back later from Settings → Backups — it returns to Closed Chats.",
        picture: "deleted",
        show: { page: "backups", anchor: "backup-list" },
      },
      {
        tag: "Security",
        title: "Your keys, safely in the backup — if you want",
        text: "Turn on “Include API keys and the memory key” and they go into the backup locked with a password you make. A restore then brings back your keys, memory and schedules, even on a new Mac.",
        picture: "secrets",
        show: { page: "backups", anchor: "backups" },
      },
      {
        tag: "New",
        title: "See what's new after every update",
        text: "Right after E.V updates, this window shows what changed, with a picture and a button to each thing. Open it again any time from Settings → Updates.",
        picture: "whatsnew",
        show: { page: "updates", anchor: "whats-new" },
      },
    ],
    smaller: [
      "A reply cut off by a crash shows a Continue button that picks up where it stopped.",
      "Half-typed messages are kept for each chat, even after a restart.",
      "Sessions still running after a restart are put back in the sidebar instead of being closed.",
      "Asking E.V to look at its own window no longer makes it close — it takes a screenshot instead.",
      "If the chat list ever can't be read, E.V stops saving over it and loads the newest good copy.",
    ],
  },
];

/** Releases to show after an update: everything newer than the last one seen, up to this version. */
export function releasesToShow(current: string, seen: string | undefined): WhatsNewRelease[] {
  return WHATS_NEW.filter((r) => !newer(r.version, current) && (seen ? newer(r.version, seen) : r.version === current));
}

/** The newest release notes this version has (for opening the window by hand). */
export function latestRelease(current: string): WhatsNewRelease[] {
  const r = WHATS_NEW.find((x) => !newer(x.version, current));
  return r ? [r] : [];
}
