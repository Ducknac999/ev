import { describe, expect, it } from "vitest";
import { solveSpoken, toExpression } from "./spokenMath";

describe("spoken math, no AI", () => {
  it("works out what people say", () => {
    expect(solveSpoken("what is two times uh three times four?")?.spoken).toBe("24.");
    expect(solveSpoken("what's 15 percent of 80")?.spoken).toBe("12.");
    expect(solveSpoken("half of 250")?.spoken).toBe("125.");
    expect(solveSpoken("12 squared")?.spoken).toBe("144.");
    expect(solveSpoken("square root of 144")?.spoken).toBe("12.");
    expect(solveSpoken("how much is forty five plus thirty eight")?.spoken).toBe("83.");
    expect(solveSpoken("one hundred twenty divided by four")?.spoken).toBe("30.");
    expect(solveSpoken("2 to the power of 10")?.spoken).toBe("1024.");
    expect(solveSpoken("seven times eight")?.spoken).toBe("56.");
  });

  it("leaves everything else to the AI", () => {
    expect(toExpression("if I have 3 apples and eat one how many are left")).toBeNull();
    expect(toExpression("what's 5 dollars in euros")).toBeNull();
    expect(toExpression("what time is it")).toBeNull();
    expect(toExpression("volume 80")).toBeNull();
    expect(toExpression("play 2 songs")).toBeNull();
    expect(toExpression("what is 42")).toBeNull();
  });
});
