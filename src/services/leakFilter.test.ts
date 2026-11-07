import { describe, expect, it } from "vitest";
import { LeakFilter, speechSafe } from "./leakFilter";

const run = (chunks: string[]) => {
  const f = new LeakFilter();
  const shown = chunks.map((c) => f.push(c)).join("") + f.end();
  return { shown, leaked: f.leaked };
};

describe("leaked tool-call markup", () => {
  it("drops it, even split across chunks", () => {
    const r = run(['<param', 'eter name="expression">2*3*4</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>']);
    expect(r.shown).toBe("");
    expect(r.leaked).toContain("2*3*4");
    const r2 = run(["It's 24.", " <｜DSML｜function", "_calls>"]);
    expect(r2.shown).toBe("It's 24.");
  });

  it("lets normal text through, including a plain < sign", () => {
    expect(run(["3 < 4 and ", "5 > 2."]).shown).toBe("3 < 4 and 5 > 2.");
    expect(run(["Use <b>bold</b> sparingly."]).shown).toBe("Use <b>bold</b> sparingly.");
    expect(run(["Hello ", "there."]).leaked).toBe("");
  });

  it("never reads markup out loud", () => {
    expect(speechSafe('Done. <parameter name="x">1</parameter>')).toBe("Done. ");
    expect(speechSafe("Fine <b>here</b>.")).toBe("Fine  here .");
  });
});
