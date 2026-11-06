import { describe, expect, it } from "vitest";
import { appsNamedIn, intoSafeCopy, keepRecentPictures, planFrom } from "../../services/jobs";
import { categoryFor, decide, DEFAULT_LEVELS, DEFAULT_NEVER_APPS, normalizeRules, type PlanScope, type PolicyContext } from "./policy";

const ctx: PolicyContext = { cwd: "/p/app", home: "/Users/me", hasProject: true, readLocal: false, taskApps: new Set(["Discord"]), neverApps: DEFAULT_NEVER_APPS };
const run = (name: string, args: Record<string, unknown>, plan: PlanScope | null = null, c = ctx) =>
  decide(categoryFor(name, args, c), DEFAULT_LEVELS, plan, name, args, c);

describe("approval rules", () => {
  it("lets harmless things just happen", () => {
    expect(run("mac_open", { app: "Vivaldi", target: "https://music.youtube.com" })).toBe("run");
    expect(run("mac_media", { action: "playpause" })).toBe("run");
    expect(run("mac_system", { volume: 30 })).toBe("run");
    expect(run("mac_look", { app: "Discord" })).toBe("run");
    expect(run("mac_click", { app: "Discord", id: 4 })).toBe("run");
    expect(run("mac_type", { text: "Hey Chris" })).toBe("run");
    expect(run("mac_clipboard", { write: "hi" })).toBe("run");
    expect(run("read_file", { path: "src/a.ts" })).toBe("run");
    expect(run("web_search", { query: "x" })).toBe("run");
  });

  it("asks for anything that changes or reveals more", () => {
    expect(run("mac_look", { app: "Mail" })).toBe("run");
    expect(run("mac_screen", {})).toBe("approve");
    expect(run("mac_clipboard", {})).toBe("approve");
    expect(run("mac_quit", { app: "Safari" })).toBe("approve");
    expect(run("mac_applescript", { script: 'tell application "Music" to play' })).toBe("approve");
    expect(run("edit_file", { path: "src/a.ts" })).toBe("approve");
    expect(run("run_command", { command: "npm test" })).toBe("approve");
    expect(run("read_file", { path: "~/.ssh/id_rsa" })).toBe("approve");
  });

  it("treats sending, deleting and installing as final", () => {
    expect(run("mac_applescript", { script: 'tell application "Messages" to send "hi" to buddy "Chris"' })).toBe("final");
    expect(run("mac_applescript", { script: 'tell application "Finder" to delete file "a.txt"' })).toBe("final");
    expect(run("run_command", { command: "rm -rf build" })).toBe("final");
    expect(run("run_command", { command: "brew install ffmpeg" })).toBe("final");
  });

  it("never touches money or never-touch apps", () => {
    expect(run("mac_open", { app: "1Password" })).toBe("never");
    expect(run("mac_look", { app: "Keychain Access" })).toBe("never");
  });

  it("runs actions inside an approved plan without asking again", () => {
    const plan: PlanScope = { title: "Fix login", files: ["src/auth.ts", "src/ui/"], commands: ["npm test"], apps: ["Music"], access: [] };
    expect(run("edit_file", { path: "src/auth.ts" }, plan)).toBe("run");
    expect(run("write_file", { path: "src/ui/login.tsx" }, plan)).toBe("run");
    expect(run("run_command", { command: "npm test -- --watch=false" }, plan)).toBe("run");
    expect(run("mac_applescript", { script: 'tell application "Music" to play' }, plan)).toBe("run");
    // Outside the fence: stops and asks.
    expect(run("edit_file", { path: "src/session.ts" }, plan)).toBe("approve");
    expect(run("run_command", { command: "npm run build" }, plan)).toBe("approve");
    expect(run("run_command", { command: "npm testx" }, plan)).toBe("approve");
    // Final steps still need their own approval.
    expect(run("run_command", { command: "rm src/auth.ts" }, plan)).toBe("final");
  });

  it("follows the user's own levels, but never unlocks money", () => {
    const rules = normalizeRules({ levels: { ...DEFAULT_LEVELS, send: "just", money: "just", scripts: "never" }, neverApps: ["Mail"] });
    expect(rules.levels.send).toBe("just");
    expect(rules.levels.money).toBe("never");
    expect(rules.levels.scripts).toBe("never");
    expect(categoryFor("mac_open", { app: "Mail" }, { ...ctx, neverApps: rules.neverApps })).toBe("money");
  });
});

describe("jobs", () => {
  it("builds the plan card and spots app names", () => {
    const plan = planFrom({ title: "Fix", steps: ["a", "b"], files: ["src/a.ts"], access: ["Screen"] }, true);
    expect(plan.progress).toEqual(["todo", "todo"]);
    expect(plan.access).toEqual(["screen"]);
    expect(appsNamedIn("Open Discord and tell Chris, then play it in Vivaldi")).toEqual(["Discord", "Vivaldi"]);
  });

  it("points paths in the real project at the safe copy", () => {
    const ws = { project: "/p/app", shadow: "/w/123-app", title: "t" };
    expect(intoSafeCopy({ path: "/p/app/src/a.ts" }, ws).path).toBe("/w/123-app/src/a.ts");
    expect(intoSafeCopy({ path: "src/a.ts" }, ws).path).toBe("src/a.ts");
    expect(intoSafeCopy({ path: "/p/application/x" }, ws).path).toBe("/p/application/x");
  });

  it("keeps only the latest pictures in the conversation", () => {
    const pic = (n: number) => ({ role: "user", parts: [{ text: `look ${n}` }, { inlineData: { data: String(n) } }] });
    const out = keepRecentPictures("gemini", [pic(1), pic(2), pic(3)]) as { parts: Record<string, unknown>[] }[];
    expect(out[0].parts[1]).toEqual({ text: "[older picture removed]" });
    expect(out[1].parts[1]).toHaveProperty("inlineData");
    expect(out[2].parts[1]).toHaveProperty("inlineData");
  });
});

describe("scripted input", () => {
  it("refuses System Events keystrokes and clicks", async () => {
    const { isGuiScripting } = await import("./macTools");
    expect(isGuiScripting('tell application "System Events" to keystroke return')).toBe(true);
    expect(isGuiScripting('tell application "System Events" to key code 36')).toBe(true);
    expect(isGuiScripting('tell application "System Events" to click button "Send" of window 1 of process "Mail"')).toBe(true);
    expect(isGuiScripting('tell application "System Events" to tell appearance preferences to set dark mode to true')).toBe(false);
    expect(isGuiScripting('tell application "Music" to play')).toBe(false);
  });
});

describe("read-only scripts", () => {
  it("lets scripts that only read run like looking", async () => {
    const { isReadOnlyScript } = await import("./policy");
    expect(isReadOnlyScript('tell application "Spotify" to get name of current track')).toBe(true);
    expect(isReadOnlyScript('tell application "Music" to return {name, artist} of current track')).toBe(true);
    expect(isReadOnlyScript('tell application "Vivaldi" to get title of every tab of front window')).toBe(true);
    expect(isReadOnlyScript('tell application "Spotify" to play')).toBe(false);
    expect(isReadOnlyScript('tell application "Finder" to delete file "a"')).toBe(false);
    expect(isReadOnlyScript('do shell script "rm -rf ~"')).toBe(false);
    expect(isReadOnlyScript('tell application "Vivaldi" to execute front window\'s active tab javascript "x"')).toBe(false);
    expect(isReadOnlyScript("Application('Spotify').currentTrack.name()", true)).toBe(false);
    expect(run("mac_applescript", { script: 'tell application "Spotify" to get name of current track' })).toBe("run");
  });

  it("describes what Approve always would cover", async () => {
    const { alwaysScope } = await import("./policy");
    expect(alwaysScope("mac_applescript", { script: 'tell application "Spotify" to play' }, "scripts", ctx)?.label).toBe("Scripts that control Spotify");
    expect(alwaysScope("run_command", { command: "npm test" }, "scripts", ctx)?.label).toBe("Run `npm test` in /p/app");
    expect(alwaysScope("edit_file", { path: "src/a.ts" }, "edit_project", ctx)?.label).toBe("Create and edit files in /p/app/src");
    expect(alwaysScope("propose_plan", {}, "internal", ctx)).toBeNull();
    expect(alwaysScope("final_action", {}, "send", ctx, { app: "Discord", where: "@Chris - Discord", what: "Click Send" })?.label).toBe("Send in Discord — @Chris - Discord");
  });
});
