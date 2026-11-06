import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "../lib/ipc";

let script: LiveEvent[] = [];
let failWith: string | null = null;
const sentText: string[] = [];
const pushed: string[] = [];

vi.mock("../lib/ipc", async (original) => ({
  ...(await original<object>()),
  livePrepare: async () => {},
  liveCancel: async () => {},
  liveTurn: async (_config: unknown, _history: unknown, text: string, onEvent: (e: LiveEvent) => void) => {
    sentText.push(text);
    if (failWith) throw failWith;
    for (const event of script) onEvent(event);
  },
}));
vi.mock("../audio/engine", () => ({
  audioEngine: { streamPcm: () => ({ push: (d: string) => pushed.push(d), finish: async () => {} }), stopPlayback: () => {} },
}));

const { turboEnabled, turboReply } = await import("./turbo");
const { useChats } = await import("../store/chats");
const { useSettings, DEFAULT_SETTINGS } = await import("../store/settings");

beforeEach(() => {
  script = [];
  failWith = null;
  sentText.length = 0;
  pushed.length = 0;
  useSettings.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      providers: { ...DEFAULT_SETTINGS.providers, gemini: { keys: [{ id: "k", name: "Gemini 1", key: "x" }], customModels: [], dailyLimits: {} } },
      voice: { ...DEFAULT_SETTINGS.voice, turbo: true },
    },
  } as never);
  useChats.setState({ focusedChatId: "c1", chats: [{ id: "c1", kind: "ai", messages: [], title: "T" }] } as never);
});

describe("turbo replies", () => {
  it("speaks a chat answer and records it in the chat", async () => {
    script = [{ kind: "audio", data: "AAAA" }, { kind: "text", text: "Doing well, " }, { kind: "text", text: "thanks." }, { kind: "done" }];
    expect(await turboReply("c1", "how are you")).toBe(true);
    expect(pushed).toEqual(["AAAA"]);
    const messages = useChats.getState().chats[0].messages;
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "how are you"],
      ["assistant", "Doing well, thanks."],
    ]);
  });

  it("hands tasks back to the normal path without recording anything", async () => {
    script = [{ kind: "handoff" }];
    expect(await turboReply("c1", "message Chris on Discord")).toBe(false);
    expect(useChats.getState().chats[0].messages).toEqual([]);
  });

  it("pauses itself when Google refuses (free limit) and falls back", async () => {
    failWith = "Gemini Live closed (1011): quota exceeded";
    expect(await turboReply("c1", "hello")).toBe(false);
    expect(turboEnabled()).toBe(false);
  });

  it("is off unless switched on", async () => {
    useSettings.setState({ settings: { ...useSettings.getState().settings, voice: { ...DEFAULT_SETTINGS.voice, turbo: false } } } as never);
    expect(await turboReply("c1", "hello")).toBe(false);
    expect(sentText).toEqual([]);
  });
});
