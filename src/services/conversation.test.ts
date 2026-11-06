import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./terminals", () => ({ writeToTerminal: () => {}, useTerminals: () => ({}) }));
const stopped: number[] = [];
vi.mock("../audio/speech", () => ({ speechQueue: { feed: () => {}, stop: () => stopped.push(Date.now()) } }));

beforeAll(() => vi.useFakeTimers());
afterAll(() => vi.useRealTimers());

describe("Hey E.V conversations", () => {
  it("only listens after the wake phrase, for the conversation window", async () => {
    const { conversation } = await import("./voiceControl");
    const { useVoice } = await import("../store/voice");
    const { useSettings, DEFAULT_SETTINGS } = await import("../store/settings");
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, voice: { ...DEFAULT_SETTINGS.voice, wakeWord: true, conversationSeconds: 20 } } } as never);

    expect(conversation.take("What's two plus two?")).toBeNull();
    expect(useVoice.getState().engaged).toBe(false);

    expect(conversation.take("Hey E.V, what's two plus two?")).toBe("what's two plus two?");
    conversation.awaitAnswer("chat-x");
    vi.advanceTimersByTime(500); // answer finished (nothing running, not speaking)
    expect(useVoice.getState().engaged).toBe(true);

    vi.advanceTimersByTime(10_000);
    expect(conversation.take("And tomorrow?")).toBe("And tomorrow?");
    conversation.awaitAnswer("chat-x");
    vi.advanceTimersByTime(500);

    vi.advanceTimersByTime(21_000); // 20 s of silence ends it
    expect(useVoice.getState().engaged).toBe(false);
    expect(conversation.take("What about Saturday?")).toBeNull();

    expect(conversation.take("Hey E.V")).toBeNull(); // waits for the question
    expect(useVoice.getState().engaged).toBe(true);
    expect(conversation.take("what time is it")).toBe("what time is it");
    expect(conversation.take("That's all")).toBeNull();
    expect(useVoice.getState().engaged).toBe(false);
    expect(conversation.take("hello?")).toBeNull();
  });

  it("counts the window from when you start talking, not when E.V has understood you", async () => {
    const { conversation } = await import("./voiceControl");
    const { useSettings, DEFAULT_SETTINGS } = await import("../store/settings");
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, voice: { ...DEFAULT_SETTINGS.voice, wakeWord: true, conversationSeconds: 10 } } } as never);
    conversation.end();
    expect(conversation.take("Hey E.V, what's the weather?")).toBe("what's the weather?");
    conversation.awaitAnswer("chat-x");
    vi.advanceTimersByTime(500); // answer done: 10 s window opens
    const answeredAt = Date.now();

    // Started talking at 8.5 s, a long question: understood only at 12 s.
    vi.advanceTimersByTime(12_000);
    expect(conversation.take("And what about the weekend, will it rain on Saturday?", answeredAt + 8_500)).toBe("And what about the weekend, will it rain on Saturday?");
    conversation.awaitAnswer("chat-x");
    vi.advanceTimersByTime(500);
    const second = Date.now();

    // Started at 11 s: too late, ignored.
    vi.advanceTimersByTime(13_000);
    expect(conversation.take("I'll tell my brother.", second + 11_000)).toBeNull();
  });

  it("stops the answer when you say Hey E.V while it talks", async () => {
    const { conversation } = await import("./voiceControl");
    const { useVoice } = await import("../store/voice");
    const before = stopped.length;
    await conversation.interrupt("");
    expect(stopped.length).toBe(before + 1);
    expect(useVoice.getState().engaged).toBe(true); // waiting for your next request
    await conversation.interrupt("that's all");
    expect(useVoice.getState().engaged).toBe(false);
  });
});
