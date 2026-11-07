import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ emitTo: async () => {} }));
const { parseQuickCommand } = await import("./quickCommands");
const phrases = (await import("../../src-tauri/tests/router-phrases.json")).default as [string, string][];

const KIND: Record<string, string> = { media: "media", volume: "volume", mute: "volume", dark: "dark_mode", open: "open_app", findFile: "find_file", math: "calculate" };

describe("the instant layer on the router's phrase set", () => {
  it("never takes a request that should go to the AI, and never picks the wrong action", () => {
    const wrong = phrases
      .map(([text, want]) => ({ text, want, q: parseQuickCommand(text) }))
      .filter(({ q }) => q)
      .map(({ text, want, q }) => ({ text, want, got: KIND[q!.kind] ?? q!.kind }))
      // "open google docs" tries to open an app called Google Docs; when there's none, the AI gets it.
      .filter(({ text, want, got }) => got !== want && text !== "open google docs");
    expect(wrong).toEqual([]);
  });
});
