import { describe, expect, it } from "vitest";
import { prepareMath } from "./MessageView";

describe("maths in chat", () => {
  it("keeps prices as text", () => {
    expect(prepareMath("It costs $5 and $10.50 total")).toBe("It costs \\$5 and \\$10.50 total");
    expect(prepareMath("so $g(k) = 4$ and $4$ apples")).toBe("so $g(k) = 4$ and $4$ apples");
  });
  it("shows a formula alone on its line full size", () => {
    expect(prepareMath("Answer:\n$$-\\frac{x+4}{7}$$\nDone")).toBe("Answer:\n$$\n-\\frac{x+4}{7}\n$$\nDone");
  });
});

describe("math that starts with a number", () => {
  it("renders $6.5\\text{M} / 3\\text{ days}$ as math, not a price", () => {
    const out = prepareMath("roughly 2.17 million views per day ($6.5\\text{M} / 3\\text{ days}$) and costs $20");
    expect(out).toContain("$6.5\\text{M} / 3\\text{ days}$");
    expect(out).toContain("\\$20");
  });
});
