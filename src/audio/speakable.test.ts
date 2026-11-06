import { describe, expect, it } from "vitest";
import { orbShouldShow } from "../store/voice";
import { takeSpeakable, toSpokenText } from "./speakable";

describe("takeSpeakable", () => {
  it("only releases complete sentences while streaming", () => {
    const first = takeSpeakable("Hello there. How are", 0, false);
    expect(first.segment).toBe("Hello there.");
    const rest = takeSpeakable("Hello there. How are you?", first.next, true);
    expect(rest.segment).toBe("How are you?");
  });

  it("waits for code fences to close and skips their contents", () => {
    const text = "Run this. ```js\nconsole.log(1). x";
    expect(takeSpeakable(text, 0, false).segment).toBe("Run this.");
    expect(toSpokenText("A **bold** [link](http://x.y) `code`.\n```\nskip\n```")).toBe("A bold link code.");
  });
});

describe("orb visibility", () => {
  it("follows the mode rules", () => {
    expect(orbShouldShow("talk", false)).toBe(true);
    expect(orbShouldShow("text", true)).toBe(true);
    expect(orbShouldShow("text", false)).toBe(false);
  });
});

describe("speaking like a person", () => {
  const answer = [
    "## 1. MKBHD (Marques Brownlee)",
    "- **Views:** ~6.4 Million",
    "- **Length:** 14:13",
    "",
    "---",
    "",
    "## 2. Linus Tech Tips",
    "- **Title:** Pros Try Fake AI Photoshop",
    "- **Views:** ~1.6M",
  ].join("\n");

  it("never says minus for dividers and counts items in words", () => {
    const spoken = toSpokenText(answer);
    expect(spoken).not.toMatch(/minus/i);
    expect(spoken).toContain("First, MKBHD");
    expect(spoken).toContain("Second, Linus Tech Tips");
    expect(spoken).toContain("about 6.4 Million");
    expect(spoken).toContain("14 minutes 13 seconds");
    expect(spoken).toContain("about 1.6 million");
  });

  it("doesn't cut a sentence after a list number", () => {
    const { segment } = takeSpeakable("Here they are.\n\n## 2. Linus Tech Tips is next", 0, false);
    expect(segment).toBe("Here they are.");
  });

  it("leaves real minus signs and clock times alone", () => {
    expect(toSpokenText("It's -5 degrees at 3:30 PM.")).toMatch(/minus 5|negative 5|-5/);
    expect(toSpokenText("It's -5 degrees at 3:30 PM.")).toContain("3:30 PM");
  });
});
