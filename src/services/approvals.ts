/**
 * Pending approval cards. The agent loop waits on `requestApproval`; the card's Approve / Deny
 * buttons (or the spoken passphrase in Talk mode) call `resolveApproval`. Actions only skip a card
 * when the fixed rule in `approvalFor` allows it.
 */
import { create } from "zustand";

export interface PendingApproval {
  approvalId: string;
  chatId: string;
  /** Spoken summary, e.g. "edit 3 lines in App.tsx and run npm test". */
  summary: string;
  /** Needs the full passphrase even inside an approval window. */
  strict: boolean;
  /** Wrong passphrase attempts so far. */
  attempts: number;
}

interface Entry extends PendingApproval {
  resolve: (outcome: Outcome) => void;
}

export type Outcome = { approved: false } | { approved: true; byVoice: boolean; always: boolean };

const waiting = new Map<string, Entry>();

/** Reactive list of what is waiting, for the voice flow and keyboard shortcuts. */
export const usePendingApprovals = create<{ list: PendingApproval[] }>(() => ({ list: [] }));

const publish = () => usePendingApprovals.setState({ list: [...waiting.values()].map(({ resolve: _r, ...rest }) => rest) });

export function requestApproval(
  info: { approvalId: string; chatId: string; summary: string; strict: boolean },
  signal: AbortSignal,
): Promise<Outcome> {
  if (signal.aborted) return Promise.resolve({ approved: false });
  return new Promise((resolve) => {
    const onAbort = () => resolveApproval(info.approvalId, false);
    signal.addEventListener("abort", onAbort, { once: true });
    waiting.set(info.approvalId, {
      ...info,
      attempts: 0,
      resolve: (outcome) => {
        signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      },
    });
    publish();
  });
}

export function resolveApproval(approvalId: string, approved: boolean, byVoice = false, always = false): void {
  const entry = waiting.get(approvalId);
  if (!entry) return;
  waiting.delete(approvalId);
  publish();
  entry.resolve(approved ? { approved: true, byVoice, always } : { approved: false });
}

/** Counts a wrong spoken passphrase; returns the new total. */
export function recordWrongAttempt(approvalId: string): number {
  const entry = waiting.get(approvalId);
  if (!entry) return 0;
  entry.attempts += 1;
  publish();
  return entry.attempts;
}

export function isAwaiting(approvalId: string): boolean {
  return waiting.has(approvalId);
}

/** Oldest approval in a chat still waiting for a decision. */
export function firstPending(chatId: string): PendingApproval | null {
  for (const entry of waiting.values()) {
    if (entry.chatId === chatId) {
      const { resolve: _r, ...rest } = entry;
      return rest;
    }
  }
  return null;
}

// ── Approval windows ──────────────────────────────────────────────────────────
// After the passphrase, "approve" alone is enough for this chat's current task for 10 minutes.

export const APPROVAL_WINDOW_MS = 10 * 60 * 1000;
const windows = new Map<string, number>();

export function openApprovalWindow(chatId: string, now = Date.now()): void {
  windows.set(chatId, now + APPROVAL_WINDOW_MS);
}

export function approvalWindowOpen(chatId: string, now = Date.now()): boolean {
  const until = windows.get(chatId);
  if (until === undefined) return false;
  if (now < until) return true;
  windows.delete(chatId);
  return false;
}

/** Called when a task ends: the next task starts with the passphrase again. */
export function closeApprovalWindow(chatId: string): void {
  windows.delete(chatId);
}
