import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ emitTo: async () => {}, listen: async () => () => {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("./voiceControl", () => ({ toggleTalkMode: () => {} }));
const { acceptPolish } = await import("./dictation");

describe("polished dictation never adds anything", () => {
  it("drops a chatty intro and refuses extra lines", () => {
    expect(acceptPolish("Much slower, not too much.", "Sure, here is the tidied text:\n\nMuch slower, not too much.")).toBe("Much slower, not too much.");
    expect(acceptPolish("Send it to Sam, no, to Maya.", "Send it to Maya.")).toBe("Send it to Maya.");
    expect(acceptPolish("Hi there.", "Hi there.\n\nLet me know if you need anything else!")).toBe("Hi there.");
  });
});
