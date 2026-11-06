import { beforeEach, describe, expect, it, vi } from "vitest";

const played: string[] = [];

vi.mock("../lib/ipc", async (original) => ({
  ...(await original<object>()),
  // The "audio" is just the text, so the test can hear what was said and in what order.
  ttsSynthesize: async (text: string) => new TextEncoder().encode(text).buffer,
}));
vi.mock("../audio/engine", () => ({
  audioEngine: {
    play: async (audio: ArrayBuffer) => {
      played.push(new TextDecoder().decode(audio));
      await new Promise((r) => setTimeout(r, 5));
    },
    stopPlayback: () => {},
    stopMic: () => {},
    duck: () => {},
  },
}));

const { useVoice } = await import("../store/voice");
const { useChats } = await import("../store/chats");
const { speechQueue } = await import("../audio/speech");
const { findChatByName, parseSwitch } = await import("./voiceControl");
const { cleanName } = await import("./chatNames");

const chat = (id: string, title: string, seq: number, extra = {}) => ({ id, kind: "ai", title, seq, messages: [], archived: false, model: { provider: "gemini", model: "gemini-3.5-flash" }, ...extra });

beforeEach(() => {
  played.length = 0;
  speechQueue.stop();
  useVoice.setState({ talkChatId: null, mode: "text", speakers: {}, speakerBeforeTalk: null });
});

describe("one microphone, per-chat speakers", () => {
  it("only one chat has Talk; switching gives the old one back its own speaker setting", () => {
    const v = useVoice.getState();
    v.setSpeaker("b", false);
    v.setTalkChat("a");
    expect(useVoice.getState()).toMatchObject({ talkChatId: "a", mode: "talk" });
    expect(useVoice.getState().speakers.a).toBe(true);
    useVoice.getState().setTalkChat("b");
    expect(useVoice.getState().talkChatId).toBe("b");
    // "a" never had its speaker on before Talk, so it goes back to off; "b" is on while it talks.
    expect(useVoice.getState().speakers).toMatchObject({ a: false, b: true });
    useVoice.getState().setTalkChat(null);
    expect(useVoice.getState()).toMatchObject({ talkChatId: null, mode: "text" });
    expect(useVoice.getState().speakers.b).toBe(false);
  });

  it("any number of chats can keep their speaker on", () => {
    for (const id of ["a", "b", "c", "d"]) useVoice.getState().setSpeaker(id, true);
    expect(Object.values(useVoice.getState().speakers).filter(Boolean)).toHaveLength(4);
    useVoice.getState().setTalkChat("c");
    useVoice.getState().setTalkChat(null);
    // A chat whose speaker was already on keeps it after Talk ends.
    expect(useVoice.getState().speakers.c).toBe(true);
  });
});

describe("switching by voice", () => {
  const chats = [chat("1", "Desmos Graphing", 1), chat("2", "Monkey Facts", 2), chat("3", "E.V Project", 3, { model: { provider: "deepseek", model: "deepseek-chat" } }), chat("t", "Claude · E.V", 4, { kind: "claude" })];

  it("understands the ways of saying it", () => {
    expect(parseSwitch("switch to DeepSeek")).toBe("DeepSeek");
    expect(parseSwitch("talk to the monkeys chat.")).toBe("the monkeys chat");
    expect(parseSwitch("go back to chat 1")).toBe("chat 1");
    expect(parseSwitch("what's the weather")).toBeNull();
  });

  it("finds the chat by name, number or model — never a Claude terminal", () => {
    expect(findChatByName("monkey facts", chats as never)?.id).toBe("2");
    expect(findChatByName("the monkey chat", chats as never)?.id).toBe("2");
    expect(findChatByName("DeepSeek", chats as never)?.id).toBe("3");
    expect(findChatByName("chat 1", chats as never)?.id).toBe("1");
    expect(findChatByName("Claude", chats as never)).toBeNull();
    expect(findChatByName("zebras", chats as never)).toBeNull();
  });
});

describe("chats take turns speaking", () => {
  it("finishes one chat's reply before the next, each starting with its name", async () => {
    speechQueue.feed("r1", "First sentence from chat two. ", false, "Monkey Facts");
    speechQueue.feed("r2", "Chat five says hello. And more.", true, "Desmos Graphing");
    speechQueue.feed("r1", "First sentence from chat two. Second sentence from chat two.", true);
    for (let i = 0; i < 100 && useVoice.getState().speaking; i++) await new Promise((r) => setTimeout(r, 10));
    expect(played).toEqual(["Monkey Facts.", "First sentence from chat two.", "Second sentence from chat two.", "Desmos Graphing.", "Chat five says hello. And more."]);
  });

  it("only says a chat's name when the speaking chat changes", async () => {
    speechQueue.feed("x1", "Hello there.", true, "Study");
    for (let i = 0; i < 100 && useVoice.getState().speaking; i++) await new Promise((r) => setTimeout(r, 10));
    speechQueue.feed("x2", "Hello again.", true, "Study");
    for (let i = 0; i < 100 && useVoice.getState().speaking; i++) await new Promise((r) => setTimeout(r, 10));
    expect(played.filter((p) => p === "Study.")).toHaveLength(1);
  });
});

describe("chat names", () => {
  it("keeps short, clean names", () => {
    expect(cleanName('"Desmos Graphing"')).toBe("Desmos Graphing");
    expect(cleanName("Title: Veritasium Latest Video.\n")).toBe("Veritasium Latest Video");
    expect(cleanName("This conversation is about many different things that the user asked")).toBeNull();
    expect(cleanName("")).toBeNull();
  });

  it("never overwrites a name the user chose, and /clear lets E.V name the new topic", () => {
    useChats.setState({ chats: [chat("x", "open vivaldi go to desmos", 1, { titleIsCustom: false, messages: [] })] } as never);
    useChats.getState().setAiTitle("x", "Desmos Graphing");
    expect(useChats.getState().chats[0]).toMatchObject({ title: "Desmos Graphing", aiNamed: true });
    useChats.getState().renameChat("x", "Homework");
    useChats.getState().setAiTitle("x", "Something Else");
    expect(useChats.getState().chats[0].title).toBe("Homework");
    useChats.getState().letGideonName("x");
    expect(useChats.getState().chats[0]).toMatchObject({ titleIsCustom: false, aiNamed: false });
    useChats.getState().setAiTitle("x", "Math Homework");
    useChats.getState().clearContext("x");
    expect(useChats.getState().chats[0].aiNamed).toBe(false);
  });
});
