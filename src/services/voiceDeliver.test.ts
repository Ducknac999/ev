import { describe, expect, it, vi } from "vitest";

const running = new Set<string>();
const sent: string[] = [];
const stopped: string[] = [];
vi.mock("./chatRunner", () => ({
  isRunning: (id: string) => running.has(id),
  stopGeneration: (id: string) => {
    stopped.push(id);
    running.delete(id);
  },
  sendMessage: async (id: string, text: string) => {
    sent.push(text);
    running.add(id);
  },
}));
vi.mock("./terminals", () => ({ writeToTerminal: () => {}, useTerminals: () => ({}) }));
vi.mock("../audio/speech", () => ({ speechQueue: { feed: () => {}, stop: () => {}, prewarm: () => {} } }));

describe("voice requests are never dropped", () => {
  it("joins a continuation and queues later requests", async () => {
    vi.useFakeTimers();
    const { conversation } = await import("./voiceControl");
    conversation.deliver("c1", "take the final cheat sheet");
    expect(sent).toEqual(["take the final cheat sheet"]);

    // The rest of the sentence arrives a moment later, while the first part is already running.
    conversation.deliver("c1", "and condense it to one page");
    await vi.advanceTimersByTimeAsync(300);
    expect(stopped).toEqual(["c1"]);
    expect(sent.at(-1)).toBe("take the final cheat sheet and condense it to one page");

    // Much later, while busy: waits its turn instead of disappearing.
    await vi.advanceTimersByTimeAsync(6_000);
    running.add("c1");
    conversation.deliver("c1", "then email it to me");
    expect(sent).toHaveLength(2);
    running.delete("c1");
    await vi.advanceTimersByTimeAsync(500);
    expect(sent.at(-1)).toBe("then email it to me");
    vi.useRealTimers();
  });
});
