import { beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, Settings } from "../types";
import { activeChats, archivedChats, useChats } from "./chats";
import { DEFAULT_SETTINGS } from "./settings";

const settings: Settings = { ...DEFAULT_SETTINGS, defaultModel: { provider: "gemini", model: "gemini-3.5-flash" } };
const store = () => useChats.getState();
const titles = () => activeChats(store().chats).map((c) => c.title);
const userMsg = (content: string): ChatMessage => ({ id: crypto.randomUUID(), role: "user", content, createdAt: Date.now() });

beforeEach(() => {
  useChats.setState({ chats: [], focusSet: [], focusedChatId: null, pendingDeleteId: null, conflict: null, layout: "hud" });
});

describe("chat numbering", () => {
  it("reuses the lowest free number and restarts at Chat 1 once everything is cleared", () => {
    const ids = Array.from({ length: 25 }, () => store().createChat(settings));
    expect(titles().at(-1)).toBe("Chat 25");

    store().deleteChat(ids[1]);
    store().createChat(settings);
    expect(titles()).toContain("Chat 2");
    expect(titles().filter((t) => t === "Chat 2")).toHaveLength(1);

    for (const c of [...store().chats]) store().deleteChat(c.id);
    store().createChat(settings);
    expect(titles()).toEqual(["Chat 1"]);
  });

  it("auto-titles from the first prompt", () => {
    const id = store().createChat(settings);
    store().appendMessage(id, userMsg("Plan a trip to Lisbon in spring"));
    expect(titles()).toEqual(["Plan a trip to Lisbon in spring"]);
  });
});

describe("close / archive / delete", () => {
  it("deletes an empty chat outright on close", () => {
    const id = store().createChat(settings);
    expect(store().closeChat(id)).toBe("deleted");
    expect(store().chats).toHaveLength(0);
  });

  it("archives a chat with history and restores it instantly", () => {
    const id = store().createChat(settings);
    store().appendMessage(id, userMsg("hello"));
    store().setLayout("focus");
    store().openInFocus(id);

    expect(store().closeChat(id)).toBe("archived");
    expect(activeChats(store().chats)).toHaveLength(0);
    expect(archivedChats(store().chats).map((c) => c.id)).toEqual([id]);
    expect(store().focusSet).not.toContain(id);
    expect(store().focusedChatId).toBeNull();

    store().restoreChat(id);
    expect(activeChats(store().chats).map((c) => c.id)).toEqual([id]);
    expect(store().focusedChatId).toBe(id);
    expect(store().focusSet).toContain(id);
  });

  it("lets any number of Claude Code sessions and chats run at once", () => {
    const a = store().createSession(settings, { kind: "claude", cwd: "/p" });
    const b = store().createSession(settings, { kind: "claude", cwd: "/p" });
    const c = store().createSession(settings, { kind: "ai", cwd: "/p" });
    expect(store().conflict).toBeNull();
    expect(store().chats.map((x) => x.kind)).toEqual(["claude", "claude", "ai"]);
    expect(store().chats.find((x) => x.id === a)?.title).toBe("Claude · p");
    expect([a, b, c].every((id) => !store().chats.find((x) => x.id === id)?.paused)).toBe(true);
  });

  it("archives closed terminal sessions so they can be reopened", () => {
    const id = store().createSession(settings, { kind: "shell", cwd: "/p" });
    expect(store().closeChat(id)).toBe("archived");
    store().restoreChat(id);
    expect(activeChats(store().chats).map((c) => c.id)).toEqual([id]);
  });

  it("/clear starts a fresh context after a divider", () => {
    const id = store().createChat(settings);
    store().appendMessage(id, userMsg("one"));
    store().clearContext(id);
    const chat = store().chats.find((c) => c.id === id)!;
    expect(chat.messages.at(-1)?.divider).toBe("clear");
    expect(chat.contextStart).toBe(2);
  });

  it("streams text into the last text block and keeps action cards in order", () => {
    const id = store().createChat(settings);
    const reply: ChatMessage = { id: "r", role: "assistant", content: "", createdAt: 0, blocks: [] };
    store().appendMessage(id, reply);
    store().appendToMessage(id, "r", "Looking");
    store().appendToMessage(id, "r", "…");
    store().addBlock(id, "r", {
      type: "tool",
      step: { id: "s1", name: "list_directory", args: {}, title: "List", status: "pending", needsApproval: true },
    });
    store().patchStep(id, "r", "s1", { status: "done", result: "a\nb" });
    store().appendToMessage(id, "r", "Done.");
    const blocks = store().chats.find((c) => c.id === id)!.messages[0].blocks!;
    expect(blocks.map((b) => (b.type === "text" ? b.text : b.step.status))).toEqual(["Looking…", "done", "Done."]);
    expect(store().chats.find((c) => c.id === id)!.messages[0].content).toBe("Looking…Done.");
  });

  it("hard delete clears every reference to the chat", () => {
    const id = store().createChat(settings);
    store().appendMessage(id, userMsg("x"));
    store().setLayout("focus");
    store().requestDelete(id);
    expect(store().pendingDeleteId).toBe(id);
    store().deleteChat(id);
    expect(store().chats).toHaveLength(0);
    expect(store().pendingDeleteId).toBeNull();
    expect(store().focusSet).toEqual([]);
    expect(store().focusedChatId).toBeNull();
  });

  it("collapse keeps the chat active and moves it out of the focus grid", () => {
    const id = store().createChat(settings);
    store().setLayout("focus");
    store().setCollapsed(id, true);
    expect(activeChats(store().chats)).toHaveLength(1);
    expect(store().focusSet).not.toContain(id);
    store().setCollapsed(id, false);
    expect(store().focusSet).toContain(id);
  });
});
