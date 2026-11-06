import { describe, expect, it } from "vitest";
import { analyzeGraph, compile, describeGraph, findZeros, parse, readGraphInput, toLatex } from "./graph";

const f = (s: string) => compile(parse(s));

describe("reading math", () => {
  it("handles the ways people write it", () => {
    expect(f("x^3 - 2x - 5")(2)).toBe(-1);
    expect(f("2(x+1)")(3)).toBe(8);
    expect(f("x(x-1)")(3)).toBe(6);
    expect(f("-x^2")(3)).toBe(-9);
    expect(f("2^-x")(1)).toBe(0.5);
    expect(f("|x| - 1")(-3)).toBe(2);
    expect(f("sin x")(Math.PI / 2)).toBeCloseTo(1);
    expect(f("2sin(x)^2")(Math.PI / 2)).toBeCloseTo(2);
    expect(f("√x + x²")(4)).toBe(18);
    expect(f("3·x − 1")(2)).toBe(5);
    expect(f("x^(1/3)")(-8)).toBeCloseTo(-2);
    expect(f("e^x")(0)).toBe(1);
    expect(f("exp(x)")(0)).toBe(1);
    expect(f("ln(e)")(0)).toBe(1);
    expect(f("pi x")(1)).toBeCloseTo(Math.PI);
  });

  it("refuses what it can't read", () => {
    expect(() => parse("x^2 + z")).toThrow(/unknown name/);
    expect(() => parse("(x+1")).toThrow(/missing \)/);
    expect(() => readGraphInput(["x^2 + y^2 = 25"])).toThrow(/y = /);
  });

  it("turns curves into LaTeX Desmos understands", () => {
    expect(toLatex(parse("x^3-2x-5"))).toBe("x^{3}-2x-5");
    expect(toLatex(parse("sqrt(x+1)/(x-2)"))).toBe("\\frac{\\sqrt{x+1}}{x-2}");
    expect(toLatex(parse("|x|"))).toBe("\\left|x\\right|");
    expect(toLatex(parse("2sin(x)"))).toBe("2\\sin\\left(x\\right)");
    expect(toLatex(parse("(x+1)^2"))).toBe("\\left(x+1\\right)^{2}");
    expect(toLatex(parse("x-(x-1)"))).toBe("x-\\left(x-1\\right)");
    expect(readGraphInput(["y = x^2"]).curves[0].latex).toBe("y=x^{2}");
  });
});

describe("finding the points", () => {
  it("finds the root of x^3 - 2x - 5 (the classic)", () => {
    const zeros = findZeros(f("x^3 - 2x - 5"));
    expect(zeros).toHaveLength(1);
    expect(zeros[0]).toBeCloseTo(2.0945515, 6);
  });

  it("finds touching roots and skips poles", () => {
    expect(findZeros(f("x^2"))).toEqual([expect.closeTo(0, 6)]);
    expect(findZeros(f("1/x"))).toEqual([]);
    expect(findZeros(f("tan(x)"), -2, 2)).toEqual([expect.closeTo(0, 6)]);
    expect(findZeros(f("x^2 + 1"))).toEqual([]);
  });

  it("describes a graph with roots, intercept and turning points", () => {
    const result = analyzeGraph(readGraphInput(["y = x^3 - 2x - 5"]));
    const text = describeGraph(result);
    expect(text).toContain("x ≈ 2.0946");
    expect(text).toContain("y-intercept: (0, -5)");
    expect(text).toMatch(/local max ≈ \(-0\.8165, -3\.9113\)/);
    expect(text).toMatch(/local min ≈ \(0\.8165, -6\.0887\)/);
    expect(result.view.xmin).toBeLessThan(-0.8);
    expect(result.view.xmax).toBeGreaterThan(2.1);
  });

  it("solves equations and finds where curves meet", () => {
    const eq = analyzeGraph(readGraphInput(["x^2 = 4"]));
    expect(eq.points.filter((p) => p.kind === "solution").map((p) => Math.round(p.x))).toEqual([-2, 2]);
    expect(describeGraph(eq)).toContain("x = -2, x = 2");
    const meet = analyzeGraph(readGraphInput(["y = x", "y = x^2"]));
    expect(meet.points.filter((p) => p.kind === "intersection").map((p) => Math.round(p.x))).toEqual([0, 1]);
  });

  it("is fast", () => {
    const started = performance.now();
    analyzeGraph(readGraphInput(["y = sin(x) + x/3", "y = 1/(x-2)", "x^3 = 2x + 5"]));
    expect(performance.now() - started).toBeLessThan(500);
  });
});
