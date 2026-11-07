import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaNow } from "../lib/ipc";

let now: MediaNow = { music: [], calls: [], other: [] };
const said: string[] = [];
const notched: string[] = [];
const paused: string[][] = [];
const resumed: string[][] = [];

vi.mock("../lib/ipc", () => ({
  mediaNow: async () => now,
  mediaPause: async (music: string[]) => (paused.push(music), music.length ? ["key"] : []),
  mediaResume: async (p: string[]) => void resumed.push(p),
  notchMessage: async (_e: string, text: string) => (notched.push(text), true),
}));
vi.mock("../audio/speech", () => ({ speechQueue: { feed: (_k: string, text: string) => said.push(text), stop: () => {} } }));
vi.mock("../store/voice", () => ({ useVoice: { getState: () => ({ muted: false, speaking: false }) } }));
vi.mock("../store/settings", () => ({
  useSettings: { getState: () => ({ settings: { voice: { replies: { typed: "silent", tasksOverMusic: "notch", important: "speak" } } } }) },
}));
vi.mock("./quickPanel", () => ({ panelShowing: () => false }));
vi.stubGlobal("document", { hasFocus: () => true });
vi.stubGlobal("AudioContext", class { createOscillator() { return { frequency: {}, connect: (n: unknown) => n, start() {}, stop() {} }; } createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (n: unknown) => n }; } get currentTime() { return 0; } get destination() { return {}; } close() {} });

beforeEach(() => {
  now = { music: [], calls: [], other: [] };
  said.length = notched.length = paused.length = resumed.length = 0;
});

describe("the talking rule", () => {
  it("speaks over audio tools like FineTune without pausing anything", async () => {
    const { announce } = await import("./announce");
    now = { music: [], calls: [], other: ["FineTune", "Brave Browser"] };
    const why = await announce("It's 4 pm.", "talk", undefined, "what time is it");
    expect(said).toEqual(["It's 4 pm."]);
    expect(paused).toEqual([]);
    expect(why).toEqual({ spoken: true, note: "🔈 Spoken: you asked by voice" });
  });

  it("pauses real music, says it, resumes it and says so", async () => {
    vi.useFakeTimers();
    const { announce } = await import("./announce");
    now = { music: ["Spotify"], calls: [], other: ["FineTune"] };
    const pending = announce("It's 4 pm.", "talk", undefined, "what time is it");
    await vi.advanceTimersByTimeAsync(5000);
    const why = await pending;
    vi.useRealTimers();
    expect(paused).toEqual([["Spotify"]]);
    expect(resumed).toEqual([["key"]]);
    expect(why.note).toBe("🔈 Spoken (Spotify paused): you asked by voice");
  });

  it("never says a command's confirmation, music or not", async () => {
    const { announce } = await import("./announce");
    for (const music of [[], ["Brave Browser"]]) {
      said.length = notched.length = 0;
      now = { music, calls: [], other: ["FineTune"] };
      const why = await announce("Next song.", "talk", undefined, "next song");
      expect(said).toEqual([]);
      expect(notched).toEqual(["Next song."]);
      expect(why).toEqual({ spoken: false, note: "🔇 Chime + notch: it was a command" });
    }
  });

  it("says a command's confirmation when asked out loud", async () => {
    const { announce } = await import("./announce");
    const why = await announce("Next song.", "talk", undefined, "next song out loud");
    expect(said).toEqual(["Next song."]);
    expect(why.spoken).toBe(true);
  });

  it("speaks a long answer to a task-like request", async () => {
    const { announce } = await import("./announce");
    const answer = "Tomorrow in Toronto it's 12 degrees and cloudy, with light rain after 4 pm and a low of 6 overnight, so bring a jacket.";
    const why = await announce(answer, "talk", undefined, "look up the weather for tomorrow");
    expect(said).toEqual([answer]);
    expect(why.spoken).toBe(true);
  });

  it("keeps quiet when asked quietly", async () => {
    const { announce } = await import("./announce");
    const why = await announce("It's 4 pm.", "talk", undefined, "what time is it, quietly");
    expect(said).toEqual([]);
    expect(why.spoken).toBe(false);
  });

  it("never talks over a call, and says why", async () => {
    const { announce } = await import("./announce");
    now = { music: [], calls: ["zoom.us"], other: [] };
    const why = await announce("It's 4 pm.", "talk", undefined, "what time is it");
    expect(said).toEqual([]);
    expect(notched).toEqual(["It's 4 pm."]);
    expect(why.spoken).toBe(false);
    expect(why.note).toContain("call (zoom.us)");
  });
});
