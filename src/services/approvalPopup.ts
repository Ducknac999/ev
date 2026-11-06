import { emitTo, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { approvalKeysActive, approvalKeysConfigure, approvalPopup, approvalPopupReturn, notchRequest, notchWithdraw } from "../lib/ipc";
import { useChats } from "../store/chats";
import { useSettings } from "../store/settings";
import { shortcutLabel } from "../lib/shortcuts";
import type { ToolStep } from "../types";
import { resolveApproval, usePendingApprovals } from "./approvals";

/**
 * Every waiting approval goes to the Vorssaint notch, the same way Claude Code's permission
 * prompts do (src-tauri/src/notch.rs): answer it there, with the three approval shortcuts from
 * Settings → Approvals, in the chat, or by voice — whichever is first wins and the rest disappear.
 * When the notch can't take it (Vorssaint isn't running), a small popup at the top right of the
 * screen (src-tauri/src/approval_popup.rs) shows it instead.
 */

/** Why the approval shortcuts couldn't be set (shown in Settings → Approvals), or null. */
export const useApprovalKeys = create<{ error: string | null }>(() => ({ error: null }));

export interface PopupItem {
  approvalId: string;
  chatTitle: string;
  /** What will happen: one line per action in the group. */
  titles: string[];
  /** Sends and deletes: can't be taken back. */
  final: boolean;
  plan: boolean;
  /** "Approve always" scope, when the action offers one. */
  always: string | null;
  /** The user's approval shortcuts, e.g. "⌃⌥A approve · ⌃⌥S always · ⌃⌥D cancel". */
  keys: string;
}

export type PopupAnswer = { approvalId: string; answer: "approve" | "always" | "deny" };

const ROW_HEIGHT = 92;
const PADDING = 18;

function items(): PopupItem[] {
  const { chats } = useChats.getState();
  return usePendingApprovals.getState().list.map((pending) => {
    const chat = chats.find((c) => c.id === pending.chatId);
    const steps: ToolStep[] = (chat?.messages ?? []).flatMap((m) =>
      (m.blocks ?? []).flatMap((b) => (b.type === "tool" && (b.step.approvalId ?? b.step.id) === pending.approvalId ? [b.step] : [])),
    );
    return {
      approvalId: pending.approvalId,
      chatTitle: chat?.title ?? "E.V",
      titles: steps.length ? steps.map((s) => s.title) : [pending.summary],
      final: steps.some((s) => s.final || s.name === "final_action"),
      plan: steps.some((s) => Boolean(s.plan)),
      always: steps.find((s) => s.always)?.always?.label ?? null,
      keys: (() => {
        const k = useSettings.getState().settings.approvalKeys;
        return `${shortcutLabel(k.approve)} approve · ${shortcutLabel(k.always)} always · ${shortcutLabel(k.cancel)} cancel`;
      })(),
    };
  });
}

/** Approvals on the notch, and those the notch couldn't take (shown in the popup instead). */
const onNotch = new Set<string>();
const inPopup = new Set<string>();

function notchPayload(item: PopupItem): Record<string, unknown> {
  return {
    id: item.approvalId,
    kind: "permission",
    tool: "E.V",
    title: item.titles[0] ?? "E.V needs your OK",
    subtitle: item.final ? `${item.chatTitle} · can't be taken back` : item.chatTitle,
    detail: [item.titles.length > 1 ? item.titles.join("\n") : "", item.always ? `“Always allow” covers: ${item.always}` : ""].filter(Boolean).join("\n") || null,
    detailStyle: "text",
    project: `E.V · ${item.chatTitle}`,
    alwaysLabel: item.always,
    keysHint: item.keys,
    // The notch only takes requests from inside E.V; this marks it as one.
    terminal: { deskSession: `ev-${item.approvalId}` },
  };
}

function toNotch(item: PopupItem): void {
  onNotch.add(item.approvalId);
  void notchRequest(item.approvalId, notchPayload(item))
    .then((answer) => {
      onNotch.delete(item.approvalId);
      if (answer === "allow" || answer === "always") resolveApproval(item.approvalId, true, false, answer === "always");
      else if (answer === "deny") resolveApproval(item.approvalId, false);
      else if (answer !== "withdrawn") toPopup(item.approvalId);
    })
    .catch(() => {
      onNotch.delete(item.approvalId);
      toPopup(item.approvalId);
    });
}

function toPopup(approvalId: string): void {
  if (!usePendingApprovals.getState().list.some((p) => p.approvalId === approvalId)) return;
  inPopup.add(approvalId);
  shown = "";
  sync();
}

let shown = "";

function sync(): void {
  const pending = items();
  const ids = new Set(pending.map((p) => p.approvalId));
  // New ones go to the notch; answered ones come off it (and out of the popup).
  for (const item of pending) if (!onNotch.has(item.approvalId) && !inPopup.has(item.approvalId)) toNotch(item);
  for (const id of [...onNotch]) if (!ids.has(id)) (onNotch.delete(id), void notchWithdraw(id).catch(() => {}));
  for (const id of [...inPopup]) if (!ids.has(id)) inPopup.delete(id);
  void approvalKeysActive(pending.length > 0).catch(() => {});
  // While you're in E.V the chat's own card is right there; the popup is for when you're elsewhere.
  const list = document.hasFocus() ? [] : pending.filter((p) => inPopup.has(p.approvalId));
  const key = JSON.stringify(list);
  if (key === shown) return;
  shown = key;
  void emitTo("approve", "approval-items", list).catch(() => {});
  const lines = list.reduce((n, item) => n + Math.min(item.titles.length, 3) - 1, 0);
  void approvalPopup(list.length > 0, PADDING + list.length * ROW_HEIGHT + lines * 18).catch(() => {});
}

function answer({ approvalId, answer }: PopupAnswer): void {
  resolveApproval(approvalId, answer !== "deny", false, answer === "always");
}

let started = false;

export function startApprovalPopup(): void {
  if (started) return;
  started = true;
  usePendingApprovals.subscribe(sync);
  window.addEventListener("focus", sync);
  window.addEventListener("blur", sync);
  // Card titles arrive with the chat; keep the popup's text in step.
  useChats.subscribe((state, previous) => {
    if (state.chats !== previous.chats && usePendingApprovals.getState().list.length) sync();
  });
  const keys = () => {
    const { approve, always, cancel } = useSettings.getState().settings.approvalKeys;
    void approvalKeysConfigure(approve, always, cancel)
      .then(() => useApprovalKeys.setState({ error: null }))
      .catch((err) => useApprovalKeys.setState({ error: String(err).includes("PERMISSION") ? "Turn on E.V in System Settings → Privacy & Security → Accessibility so these shortcuts work from any app." : String(err) }));
  };
  keys();
  useSettings.subscribe((state, previous) => {
    if (state.settings.approvalKeys !== previous.settings.approvalKeys) keys();
  });
  void listen<PopupAnswer>("approval-answer", (event) => {
    answer(event.payload);
    void approvalPopupReturn().catch(() => {});
  }).catch(() => {});
  // The approval shortcuts, from any app, answer the oldest one (the one the notch shows first).
  void listen<"approve" | "always" | "deny">("approval-key", (event) => {
    const first = usePendingApprovals.getState().list[0];
    if (first) answer({ approvalId: first.approvalId, answer: event.payload });
  }).catch(() => {});
  // The popup's page loads after the first approval shows it: send it the list again.
  void listen("approval-popup-ready", () => {
    shown = "";
    sync();
  }).catch(() => {});
}
