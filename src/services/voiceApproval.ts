import { speechQueue } from "../audio/speech";
import { uid } from "../lib/ids";
import { passphraseCheck, passphraseStatus } from "../lib/ipc";
import { useVoice } from "../store/voice";
import {
  approvalWindowOpen,
  firstPending,
  openApprovalWindow,
  recordWrongAttempt,
  resolveApproval,
  usePendingApprovals,
  type PendingApproval,
} from "./approvals";

/**
 * Spoken approvals in Talk mode. E.V reads out what needs approval; the user answers with the
 * passphrase (or "approve" inside an approval window) or "skip". What is said here is never sent
 * to the AI or saved in the chat.
 */

export const MAX_ATTEMPTS = 3;

let hasPassphrase = false;
const announced = new Set<string>();

export async function refreshPassphraseStatus(): Promise<boolean> {
  hasPassphrase = await passphraseStatus().catch(() => false);
  return hasPassphrase;
}

function say(text: string): void {
  speechQueue.feed(uid("approval-"), text, true);
}

/** The approval the user is being asked about right now, if they are talking to that chat. */
export function activeVoiceApproval(): PendingApproval | null {
  const { mode, talkChatId: chatId } = useVoice.getState();
  if (mode !== "talk" || !chatId) return null;
  return firstPending(chatId);
}

const has = (text: string, words: string) => new RegExp(`\\b(${words})\\b`, "i").test(text);

function announce(pending: PendingApproval): void {
  if (announced.has(pending.approvalId)) return;
  announced.add(pending.approvalId);
  if (!hasPassphrase) say(`Approval needed to ${pending.summary}. Tap Approve on screen.`);
  else if (!pending.strict && approvalWindowOpen(pending.chatId)) say(`Approval needed to ${pending.summary}. Say approve, or skip.`);
  else say(`I need approval to ${pending.summary}. Say your passphrase, or say skip.`);
}

/** Handles one thing the user said while an approval is waiting. */
export async function hearForApproval(text: string): Promise<void> {
  const pending = activeVoiceApproval();
  if (!pending) return;
  const { approvalId, chatId, strict } = pending;
  if (has(text, "skip|cancel|deny")) {
    resolveApproval(approvalId, false);
    say("Skipped.");
    return;
  }
  if (!hasPassphrase) {
    say("Tap Approve on screen, or say skip.");
    return;
  }
  const windowOpen = approvalWindowOpen(chatId);
  if (has(text, "approve|approved") && windowOpen && !strict) {
    resolveApproval(approvalId, true, true);
    say("Approved.");
    return;
  }
  if (await passphraseCheck(text)) {
    // "<passphrase> always" saves it to the Always approved list; the passphrase alone is once.
    const always = /\balways\b/i.test(text);
    openApprovalWindow(chatId);
    resolveApproval(approvalId, true, true, always);
    say(always ? "Always approved." : "Approved.");
    return;
  }
  if (has(text, "approve|approved")) {
    // Not a wrong passphrase, just the short word where it isn't enough.
    say(windowOpen ? "This one needs your passphrase." : "Say your passphrase to approve, or say skip.");
    return;
  }
  const attempts = recordWrongAttempt(approvalId);
  if (attempts >= MAX_ATTEMPTS) {
    resolveApproval(approvalId, false);
    say("That's not right. Cancelled after three tries.");
  } else {
    say("That's not right. Try again, or say skip.");
  }
}

let started = false;

/** Announces approvals for the chat being talked to, whenever one appears or Talk mode starts. */
export function startVoiceApprovals(): void {
  if (started) return;
  started = true;
  void refreshPassphraseStatus();
  const check = () => {
    const pending = activeVoiceApproval();
    if (pending) announce(pending);
  };
  usePendingApprovals.subscribe(check);
  useVoice.subscribe((state, previous) => {
    if (state.mode !== previous.mode || state.talkChatId !== previous.talkChatId) check();
  });
}
