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
