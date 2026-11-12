import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({}));
vi.mock("../store/settings", () => ({ useSettings: { getState: () => ({ settings: { browsers: { preferred: null, notUsing: [], known: {} } } }) } }));

const { aliases, browsersNamed } = await import("./browsers");

const MAC = ["Ardia", "Brave Browser", "Google Chrome", "Safari"];

describe("browsers named in a message", () => {
  it("reads the cstimer message: uses Ardia, stopped using Brave", () => {
    const text =
      "The CS timer tab is already open for me and It's open. I want you to use it and also remember: I'm using a browser called.  ardia in my macbook i stopped using brave and stimer is opened in a tab there use that";
    expect(browsersNamed(text, MAC)).toEqual({ use: "Ardia", stopped: ["Brave Browser"] });
  });

  it("knows the short names people use", () => {
    expect(aliases("Brave Browser")).toContain("brave");
    expect(aliases("Google Chrome")).toContain("chrome");
    expect(browsersNamed("open it in chrome", MAC).use).toBe("Google Chrome");
  });

  it("hears 'not anymore' after the name", () => {
    expect(browsersNamed("I use Safari now, not Brave anymore", MAC)).toEqual({ use: "Safari", stopped: ["Brave Browser"] });
  });

  it("ignores words that only contain a browser's name", () => {
    expect(browsersNamed("the safarist was there", MAC)).toEqual({ use: null, stopped: [] });
  });
});
