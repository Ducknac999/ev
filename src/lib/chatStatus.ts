import { PROVIDERS } from "../providers/catalog";
import type { Chat } from "../types";

export type StatusKind = "ready" | "streaming" | "locked" | "paused" | "error";

export interface StatusInfo {
  kind: StatusKind;
  label: string;
}

/** Single status shown on cards, rows and badges. Priority: streaming > error > paused > locked > ready. */
export function chatStatus(chat: Chat): StatusInfo {
  if (chat.status === "streaming") return { kind: "streaming", label: "Streaming" };
  if (chat.status === "error") return { kind: "error", label: "Error" };
  if (chat.paused) return { kind: "paused", label: "Paused" };
  if (PROVIDERS[chat.model.provider].locked) return { kind: "locked", label: "Locked" };
  return { kind: "ready", label: "Ready" };
}

export function relativeTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function lastPreview(chat: Chat): string {
  if (chat.kind === "browser") return "E.V's own browser";
  if (chat.kind !== "ai") return chat.kind === "command" ? (chat.command ?? "") : (chat.cwd ?? "~").replace(/^\/Users\/[^/]+/, "~");
  const last = [...chat.messages].reverse().find((m) => m.content.trim());
  return last ? last.content.replace(/[`*#>_]/g, "").replace(/\s+/g, " ").trim() : "No messages yet";
}
