import { beforeEach, describe, expect, it, vi } from "vitest";

const spoken: string[] = [];
const PASSPHRASE = "copper lantern 9";

vi.mock("./announce", () => ({ announceImportant: async (text: string) => void spoken.push(text) }));
vi.mock("../audio/speech", () => ({
  speechQueue: { feed: (_key: string, text: string) => spoken.push(text), stop: () => {} },
}));
vi.mock("../lib/ipc", () => ({
  passphraseStatus: async () => true,
  passphraseCheck: async (heard: string) =>
    ` ${heard.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\bnine\b/g, "9")} `.includes(` ${PASSPHRASE} `),
}));

const { useChats } = await import("../store/chats");
const { useVoice } = await import("../store/voice");
const approvals = await import("./approvals");
const voice = await import("./voiceApproval");

const CHAT = "chat-1";
let n = 0;

function ask(strict = false) {
  const approvalId = `approval-${++n}`;
  const signal = new AbortController().signal;
  const outcome = approvals.requestApproval({ approvalId, chatId: CHAT, summary: "edit 3 lines in App.tsx", strict }, signal);
  return { approvalId, outcome };
}

beforeEach(async () => {
  spoken.length = 0;
  approvals.closeApprovalWindow(CHAT);
  useChats.setState({ focusedChatId: CHAT });
  useVoice.setState({ mode: "talk", talkChatId: CHAT });
  await voice.refreshPassphraseStatus();
  voice.startVoiceApprovals();
});

describe("spoken approvals", () => {
  it("announces the action and approves with the passphrase", async () => {
    const { outcome } = ask();
    expect(spoken.at(-1)).toBe("I need approval to edit 3 lines in App.tsx. Say your passphrase, or say skip.");
    await voice.hearForApproval("Uh, copper lantern nine.");
    await expect(outcome).resolves.toEqual({ approved: true, byVoice: true, always: false });
    expect(spoken.at(-1)).toBe("Approved.");
  });

  it("saves an Approve always when the passphrase is followed by always", async () => {
    const { outcome } = ask();
    await voice.hearForApproval("copper lantern nine always");
    await expect(outcome).resolves.toEqual({ approved: true, byVoice: true, always: true });
    expect(spoken.at(-1)).toBe("Always approved.");
    const second = ask();
    await voice.hearForApproval("always");
    expect(approvals.isAwaiting(second.approvalId)).toBe(true);
    approvals.resolveApproval(second.approvalId, false);
  });

  it("cancels after three wrong tries", async () => {
    const { approvalId, outcome } = ask();
    await voice.hearForApproval("blue falcon");
    expect(spoken.at(-1)).toBe("That's not right. Try again, or say skip.");
    await voice.hearForApproval("red falcon");
    expect(approvals.isAwaiting(approvalId)).toBe(true);
    await voice.hearForApproval("green falcon");
    await expect(outcome).resolves.toEqual({ approved: false });
    expect(spoken.at(-1)).toBe("That's not right. Cancelled after three tries.");
  });

  it("denies on skip", async () => {
    const { outcome } = ask();
    await voice.hearForApproval("skip");
    await expect(outcome).resolves.toEqual({ approved: false });
  });

  it("accepts 'approve' inside the window, but not for strict actions", async () => {
    await voice.hearForApproval("x"); // nothing pending: ignored
    const first = ask();
    await voice.hearForApproval("copper lantern nine");
    await first.outcome;

    const second = ask();
    expect(spoken.at(-1)).toBe("Approval needed to edit 3 lines in App.tsx. Say approve, or skip.");
    await voice.hearForApproval("approve");
    await expect(second.outcome).resolves.toEqual({ approved: true, byVoice: true, always: false });

    const strict = ask(true);
    await voice.hearForApproval("approve");
    expect(approvals.isAwaiting(strict.approvalId)).toBe(true);
    expect(spoken.at(-1)).toBe("This one needs your passphrase.");
    await voice.hearForApproval("copper lantern 9");
    await expect(strict.outcome).resolves.toEqual({ approved: true, byVoice: true, always: false });
  });

  it("needs the passphrase again after the window or the task ends", async () => {
    const first = ask();
    await voice.hearForApproval("copper lantern nine");
    await first.outcome;
    approvals.closeApprovalWindow(CHAT);
    const next = ask();
    await voice.hearForApproval("approve");
    expect(approvals.isAwaiting(next.approvalId)).toBe(true);
    approvals.resolveApproval(next.approvalId, false);

    approvals.openApprovalWindow(CHAT, Date.now() - approvals.APPROVAL_WINDOW_MS - 1);
    expect(approvals.approvalWindowOpen(CHAT)).toBe(false);
  });

  it("stays silent in Text mode", async () => {
    useVoice.setState({ mode: "text", talkChatId: null });
    const { approvalId } = ask();
    expect(spoken).toEqual([]);
    expect(voice.activeVoiceApproval()).toBeNull();
    approvals.resolveApproval(approvalId, true);
  });
});
