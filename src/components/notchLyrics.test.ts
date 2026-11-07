import { describe, expect, it } from "vitest";
import { parseLrc } from "./Notch";

describe("synced lyrics", () => {
  it("reads LRC timestamps in order", () => {
    const lines = parseLrc("[00:12.50] second\n[00:01.00] first\n[00:20.00][00:40.00] chorus\n[ar: someone]");
    expect(lines.map((l) => l.text)).toEqual(["first", "second", "chorus", "chorus"]);
    expect(lines[0].t).toBe(1);
    expect(lines[3].t).toBe(40);
  });
});
