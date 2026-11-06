import { describe, expect, it } from "vitest";
import { browserPersonal, personalInfo } from "./browserTools";
import { categoryFor, decide, DEFAULT_RULES, type PolicyContext } from "./policy";
import { findRecipe, learn, routeOf } from "../../services/recipes";
import type { ToolStep } from "../../types";

const ctx = (readLocal = false): PolicyContext => ({ cwd: "/p", home: "/Users/u", hasProject: true, readLocal, taskApps: new Set(), neverApps: [] });
const run = (name: string, args: Record<string, unknown>, readLocal = false) =>
  decide(categoryFor(name, args, ctx(readLocal)), DEFAULT_RULES.levels, null, name, args, ctx(readLocal));

describe("the E.V Browser's rules", () => {
  it("browses, clicks, types and posts without asking", () => {
    expect(run("browser_go", { url: "https://github.com/vercel/next.js" })).toBe("run");
    expect(run("browser_do", { steps: [{ do: "type", id: 3, text: "lofi beats", submit: true }, { do: "click", id: 9 }] })).toBe("run");
    expect(run("browser_do", { steps: [{ do: "type", id: 2, text: "Great video, thanks!" }, { do: "click", id: 5 }] })).toBe("run");
    expect(run("browser_look", {})).toBe("run");
    expect(run("make_graph", { expressions: ["x^2"] })).toBe("run");
    expect(categoryFor("make_graph", { expressions: ["x^2"] }, ctx())).toBe("internal");
  });

  it("asks before typing the user's details into a website", () => {
    expect(personalInfo("reach me at sam.lee@gmail.com")).toBe("an email address");
    expect(personalInfo("call (510) 555-0199")).toBe("a phone number");
    expect(personalInfo("I live at 4521 Mission Blvd")).toBe("a street address");
    expect(personalInfo("best pizza in springfield")).toBeNull();
    expect(run("browser_do", { steps: [{ do: "type", id: 4, text: "sam.lee@gmail.com" }] })).toBe("approve");
    expect(browserPersonal("browser_do", { steps: [{ do: "type", id: 4, text: "hello" }] }, true)).toMatch(/after reading your files/);
    expect(run("browser_do", { steps: [{ do: "type", id: 4, text: "hello" }] }, true)).toBe("approve");
  });

  it("opening pages after reading local files asks (they could carry data out)", () => {
    expect(run("browser_go", { url: "https://example.com/?q=secret" }, true)).toBe("approve");
    expect(run("browser_do", { steps: [{ do: "go", url: "https://example.com" }] }, true)).toBe("approve");
  });

  it("the batch Mac tool and 'what's in front' follow the Mac rules", () => {
    expect(categoryFor("mac_do", { app: "Discord", steps: [] }, ctx())).toBe("prepare");
    expect(categoryFor("mac_front", {}, ctx())).toBe("look_app");
  });
});

describe("learned routes", () => {
  const step = (name: string, title: string, status: ToolStep["status"] = "done"): ToolStep => ({ id: title, name, args: {}, title, status, needsApproval: false });

  it("keeps the route of a task that worked", () => {
    const route = routeOf([step("browser_go", "Open youtube.com"), step("browser_look", "Read"), step("browser_do", "E.V Browser: type “lofi” ⏎ → click #12")]);
    expect(route).toEqual(["Open youtube.com", "E.V Browser: type “lofi” ⏎ → click #12"]);
    expect(routeOf([step("browser_go", "Open"), step("browser_do", "Send", "denied")])).toBeNull();
    expect(routeOf([step("web_search", "Search")])).toBeNull();
  });

  it("finds it again for a similar request, not for a different one", () => {
    const recipes = learn([], "play lofi beats on youtube", ["Open youtube.com", "type lofi"], "r1");
    expect(findRecipe("play some lofi beats on YouTube please", recipes)?.id).toBe("r1");
    expect(findRecipe("what's the weather in Paris", recipes)).toBeNull();
    // Learning the same task again replaces it instead of piling up.
    expect(learn(recipes, "play lofi beats on youtube", ["new"], "r2")).toHaveLength(1);
  });
});
