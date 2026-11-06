import { isLockedProvider } from "../providers/catalog";
import type { Chat, ModelRef } from "../types";

/**
 * Lock ownership is derived from chat state: a locked provider belongs to the single
 * non-paused, non-archived chat currently assigned to it. Every mutation keeps that invariant.
 */
export function lockHolder(chats: Chat[], model: ModelRef, excludeChatId?: string): Chat | undefined {
  if (!isLockedProvider(model.provider)) return undefined;
  return chats.find(
    (c) => c.kind === "ai" && c.id !== excludeChatId && !c.paused && !c.archived && c.model.provider === model.provider,
  );
}

export type AssignmentResult =
  | { kind: "assigned" }
  | { kind: "conflict"; holderChatId: string };

export function checkAssignment(chats: Chat[], chatId: string, model: ModelRef): AssignmentResult {
  const holder = lockHolder(chats, model, chatId);
  return holder ? { kind: "conflict", holderChatId: holder.id } : { kind: "assigned" };
}
