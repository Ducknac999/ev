import { describe, expect, it } from "vitest";
import { cleanTranscript } from "./transcriptCleanup";

describe("cleaning what was heard", () => {
  it("takes out fillers and stutters, keeps the meaning", () => {
    expect(cleanTranscript("Um, what is 2 times, uh, 3 times 4?")).toBe("What is 2 times 3 times 4?");
    expect(cleanTranscript("Hey E. V, can you can you open my resume and then, um, email it to Vor Saint by Friday, actually Thursday.", { dictionary: ["Vorssaint"] })).toBe(
      "Hey E.V, can you open my resume and then email it to Vorssaint by Thursday.",
    );
    expect(cleanTranscript("I I think it's very very good")).toBe("I think it's very very good");
    expect(cleanTranscript("set it for 5, no wait 6")).toBe("Set it for 6");
    expect(cleanTranscript("uh")).toBe("uh");
  });

  it("writes the marks you say when dictating, not in requests", () => {
    expect(cleanTranscript("hi Maya comma see you at 6 period new line thanks", { mode: "dictation" })).toBe("Hi Maya, see you at 6.\nthanks");
    expect(cleanTranscript("No, before we go ahead, go ahead and talk about it")).toBe("No, before we go ahead, go ahead and talk about it");
    expect(cleanTranscript("what does period mean")).toBe("What does period mean");
  });

  it("uses your spellings for names", () => {
    expect(cleanTranscript("open duck knack's repo", { dictionary: ["Ducknac"] })).toBe("Open duck knack's repo");
    expect(cleanTranscript("tell duck nack hi", { dictionary: ["Ducknac"] })).toBe("Tell Ducknac hi");
  });
});
