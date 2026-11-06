import { describe, expect, it } from "vitest";
import type { KeyView } from "../providers/keyPool";
import { formatReset, keyStatusText, remainingText, toneFor } from "./usageFormat";

const view = (patch: Partial<KeyView>): KeyView => ({
  id: "k",
  name: "Gemini 1",
  status: "ready",
  usedBy: [],
  until: null,
  used: 0,
  limit: 250,
  remaining: 250,
  resetAt: null,
  limitSource: "estimate",
  ...patch,
});

describe("usage formatting", () => {
  it("bands bar colours by how much is used", () => {
    expect(toneFor(0.2)).toBe("ok");
    expect(toneFor(0.7)).toBe("warn");
    expect(toneFor(0.95)).toBe("bad");
  });

  it("formats near and far resets", () => {
    const now = new Date(2026, 9, 8, 10, 0, 0).getTime();
    expect(formatReset(now + 42_000, now)).toBe("in 42s");
    expect(formatReset(now + 18 * 60_000, now)).toBe("in 18m");
    expect(formatReset(now - 1, now)).toBe("now");
    expect(formatReset(new Date(2026, 9, 8, 22, 29).getTime(), now)).toMatch(/10:29/);
    expect(formatReset(new Date(2026, 9, 14, 16, 59).getTime(), now)).toMatch(/^Wed /);
  });

  it("describes each key state", () => {
    const now = 0;
    const titleOf = (id: string) => (id === "c2" ? "Chat 2" : id);
    expect(keyStatusText(view({ status: "in-use", usedBy: ["c2"] }), titleOf, now)).toBe("in use · Chat 2");
    expect(keyStatusText(view({}), titleOf, now)).toBe("free");
    expect(keyStatusText(view({ status: "cooling", until: 30_000 }), titleOf, now)).toBe("rate limited · in 30s");
    expect(keyStatusText(view({ status: "exhausted", until: 30 * 60_000 }), titleOf, now)).toBe("used up · resets in 30m");
    expect(keyStatusText(view({ status: "invalid" }), titleOf, now)).toBe("rejected — check key");
  });

  it("summarises what is left", () => {
    expect(remainingText(view({ used: 68, remaining: 182 }))).toBe("182/250 left");
    expect(remainingText(view({ used: 4, limit: null, remaining: null }))).toBe("4 used today");
  });
});
