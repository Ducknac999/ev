import { describe, expect, it } from "vitest";
import { speakMath } from "./mathSpeech";
import { toSpokenText } from "./speakable";

describe("maths read aloud", () => {
  const say = (t: string) => toSpokenText(t);

  it("reads the composition problem like a teacher would", () => {
    expect(say("To solve for $x$ when $(g \\circ f)(x) = 4$, follow these steps:")).toBe("To solve for x when g of f of x equals 4, follow these steps:");
    expect(say("$(g \\circ f)(x)$ means $g(f(x)) = 4$.")).toBe("g of f of x means g of f of x equals 4.");
  });

  it("says fractions, roots, powers and signs", () => {
    expect(speakMath("$\\frac{x+4}{7}$")).toBe("x plus 4 over 7");
    expect(speakMath("$-\\frac{x + 4}{7}$")).toBe("negative x plus 4 over 7");
    expect(speakMath("$\\sqrt{x^2 + 9}$")).toBe("the square root of x squared plus 9");
    expect(speakMath("$x^{10} \\geq 3$")).toBe("x to the power of 10 is greater than or equal to 3");
    expect(speakMath("$a_1 \\cdot b$")).toBe("a sub 1 times b");
    expect(speakMath("$$y = 2x - 3$$").trim()).toBe("y equals 2x minus 3");
  });

  it("handles plain-text maths too", () => {
    expect(say("-(x + 4) / 7")).toBe("negative x plus 4 over 7");
  });

  it("leaves prices and ordinary text alone", () => {
    expect(say("It costs $5 and $10 at the store.")).toBe("It costs $5 and $10 at the store.");
    expect(say("Ask him and/or her.")).toBe("Ask him and/or her.");
    expect(say("Take 3/4 of it.")).toBe("Take 3 over 4 of it.");
  });
});
