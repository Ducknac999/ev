import { describe, expect, it } from "vitest";
import { checkerRequest, checkerSystemPrompt, parseVerdict, withAnswerText } from "./verify";

describe("fact-check", () => {
  it("reads the checker's verdict", () => {
    expect(parseVerdict("VERIFIED", "draft")).toEqual({ verdict: "verified" });
    expect(parseVerdict("CORRECTED\nThe race is Sun Oct 11, 5:00 AM PT.", "The race is at 12:00 PM.")).toEqual({
      verdict: "corrected",
      text: "The race is Sun Oct 11, 5:00 AM PT.",
    });
    expect(parseVerdict("CORRECTED\ndraft", "draft")).toEqual({ verdict: "verified" });
    expect(parseVerdict("I think it's fine", "draft")).toEqual({ verdict: "unchecked" });
  });

  it("gives the checker the question, every source and the draft within a budget", () => {
    const text = checkerRequest("when is the race?", [{ title: "Check F1", output: "Race: Sun 5:00 AM PDT" }, { title: "big", output: "x".repeat(20_000) }], "12 PM");
    expect(text).toContain("[1] Check F1\nRace: Sun 5:00 AM PDT");
    expect(text).toContain("Draft answer:\n12 PM");
    expect(text.length).toBeLessThan(20_000);
    expect(checkerSystemPrompt()).toMatch(/time zone/);
  });

  it("stores the checked answer in place of the draft", () => {
    const gemini = withAnswerText("gemini", { role: "model", parts: [{ thoughtSignature: "s" }, { text: "draft" }] }, "fixed");
    expect(gemini).toEqual({ role: "model", parts: [{ thoughtSignature: "s" }, { text: "fixed" }] });
    expect(withAnswerText("groq", { role: "assistant", content: "draft" }, "fixed")).toEqual({ role: "assistant", content: "fixed" });
  });
});
