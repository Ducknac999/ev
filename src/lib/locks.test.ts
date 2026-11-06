import { describe, expect, it } from "vitest";
import type { Chat, ModelRef } from "../types";
import { checkAssignment, lockHolder } from "./locks";

const chat = (id: string, model: ModelRef, paused = false): Chat => ({
  id,
  kind: "ai",
  title: id,
  titleIsCustom: false,
  model,
  messages: [],
  status: "idle",
  paused: paused ? { byChatId: "x", byChatTitle: "x", at: 0 } : null,
  collapsed: false,
  archived: false,
  seq: 1,
  unseen: false,
  createdAt: 0,
  updatedAt: 0,
});

const claude = { provider: "claude", model: "sonnet" } as const;
const claudeOpus = { provider: "claude", model: "opus" } as const;
const gemini = { provider: "gemini", model: "gemini-3.5-flash" } as const;
const groq = { provider: "groq", model: "llama-3.3-70b-versatile" } as const;

describe("model locks", () => {
  it("never locks: any number of chats and Claude Code sessions run at once", () => {
    const chats = [chat("c1", claude), chat("c2", gemini), chat("c3", groq)];
    expect(checkAssignment(chats, "c2", claudeOpus)).toEqual({ kind: "assigned" });
    expect(checkAssignment(chats, "c3", gemini)).toEqual({ kind: "assigned" });
    expect(lockHolder(chats, claude, "c2")).toBeUndefined();
  });

  it("ignores terminal sessions when resolving a holder", () => {
    const terminal = { ...chat("t1", claude), kind: "claude" as const };
    expect(lockHolder([terminal], claude)).toBeUndefined();
  });
});
