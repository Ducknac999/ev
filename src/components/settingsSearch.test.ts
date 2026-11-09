import { describe, expect, it } from "vitest";
import { ENTRIES, PAGES, searchSettings } from "./settingsSearch";

const top = (q: string) => searchSettings(q)[0]?.entry.title ?? "";
const titles = (q: string) => searchSettings(q).map((h) => h.entry.title);

describe("settings search", () => {
  it("finds a setting from part of a word", () => {
    expect(top("clip")).toMatch(/Clipboard/);
    expect(top("dict")).toMatch(/Dictation|dictionary/);
  });

  it("forgives typos", () => {
    expect(top("clipbord")).toMatch(/Clipboard/);
    expect(top("dictaton")).toMatch(/Dictation/);
    expect(top("pasphrase")).toMatch(/Passphrase/);
    expect(top("caffiene")).toMatch(/Caffeine/);
  });

  it("knows other words for the same thing", () => {
    expect(top("copy paste")).toMatch(/Clipboard/);
    expect(top("keep awake")).toMatch(/Caffeine/);
    expect(titles("mic").join()).toMatch(/Dictation|Talk|Hey E.V/);
    expect(top("money")).toBe("Spending limit");
    expect(titles("hotkey").join()).toMatch(/shortcut/i);
    expect(top("update")).toBe("Updates");
    expect(top("gmail")).toMatch(/Connections/);
  });

  it("reads phrases and ignores filler", () => {
    expect(top("turn off the notch")).toBe("E.V notch on or off");
    expect(top("hide in full screen")).toMatch(/full-screen/);
    expect(titles("change shortcut").join()).toMatch(/shortcut/i);
  });

  it("finds nothing for nonsense and empty input", () => {
    expect(searchSettings("zzqxv")).toEqual([]);
    expect(searchSettings("   ")).toEqual([]);
  });

  it("points every entry at a real page", () => {
    const pages = new Set(PAGES.map((p) => p.id));
    for (const e of ENTRIES) expect(pages.has(e.page)).toBe(true);
  });
});
