import { describe, expect, it } from "vitest";
import { lineDiff } from "./diff";
import { buildSystemPrompt, summaryContext } from "./prompt";
import { absolutePath, approvalFor, describeTool, executeTool, isDeleteCommand, isSafeCommand, MAX_SEARCHES_PER_TASK, reachesOutside } from "./tools";
import { compactTranscript, geminiAdapter } from "./adapters";

describe("line diff", () => {
  it("shows changed lines with context and line numbers", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
    const after = ["a", "b", "c", "d", "E", "f", "g", "h", "i", "j"].join("\n");
    const { lines } = lineDiff(before, after);
    expect(lines.map((l) => `${l.kind}:${l.text}:${l.line ?? ""}`)).toEqual([
      "ctx:b:2",
      "ctx:c:3",
      "ctx:d:4",
      "del:e:5",
      "add:E:5",
      "ctx:f:6",
      "ctx:g:7",
      "ctx:h:8",
    ]);
  });

  it("marks every line added for a new file", () => {
    const { lines } = lineDiff("", "x\ny\n");
    expect(lines.map((l) => l.kind)).toEqual(["add", "add"]);
  });

  it("collapses distant unchanged regions into gaps", () => {
    const before = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l2\n", "L2\n").replace("l27", "L27");
    const kinds = lineDiff(before, after).lines.map((l) => l.kind);
    expect(kinds).toContain("gap");
    expect(kinds.filter((k) => k === "add")).toHaveLength(2);
  });
});

describe("agent tools", () => {
  it("resolves paths like the backend", () => {
    expect(absolutePath("src/a.ts", "/p/app", "/Users/me")).toBe("/p/app/src/a.ts");
    expect(absolutePath("~/Desktop", "/p", "/Users/me")).toBe("/Users/me/Desktop");
    expect(absolutePath("../x", "/p/app", "/Users/me")).toBe("/p/x");
  });

  it("flags actions that reach outside the project folder", () => {
    expect(reachesOutside("read_file", { path: "src/a.ts" }, "/p/app", "/Users/me")).toBe(false);
    expect(reachesOutside("read_file", { path: "~/.ssh/id_rsa" }, "/p/app", "/Users/me")).toBe(true);
    expect(reachesOutside("find_files", { pattern: "E.V", everywhere: true }, "/p/app", "/Users/me")).toBe(true);
    expect(reachesOutside("run_command", { command: "ls" }, "/p/app", "/Users/me")).toBe(false);
  });

  it("applies the approval rule: look inside freely, ask to change, passphrase outside", () => {
    const ctx = { cwd: "/p/app", home: "/Users/me", hasProject: true, readLocal: false };
    expect(approvalFor("web_search", { query: "weather" }, ctx)).toBe("auto");
    expect(approvalFor("todo_write", {}, ctx)).toBe("auto");
    expect(approvalFor("web_fetch", { url: "https://a.com" }, ctx)).toBe("auto");
    expect(approvalFor("web_fetch", { url: "https://a.com" }, { ...ctx, readLocal: true })).toBe("ask");
    expect(approvalFor("read_file", { path: "src/a.ts" }, ctx)).toBe("auto");
    expect(approvalFor("search_files", { pattern: "x" }, ctx)).toBe("auto");
    expect(approvalFor("read_file", { path: "~/.ssh/id_rsa" }, ctx)).toBe("strict");
    expect(approvalFor("find_files", { pattern: "E.V", everywhere: true }, ctx)).toBe("strict");
    expect(approvalFor("edit_file", { path: "src/a.ts" }, ctx)).toBe("ask");
    expect(approvalFor("write_file", { path: "/etc/hosts" }, ctx)).toBe("strict");
    expect(approvalFor("run_command", { command: "git status" }, ctx)).toBe("auto");
    expect(approvalFor("run_command", { command: "npm test" }, ctx)).toBe("ask");
    expect(approvalFor("run_command", { command: "rm -rf build" }, ctx)).toBe("strict");
    // Without a chosen project folder nothing on the Mac is free.
    expect(approvalFor("read_file", { path: "a.ts" }, { ...ctx, hasProject: false })).toBe("strict");
    expect(approvalFor("run_command", { command: "ls" }, { ...ctx, hasProject: false })).toBe("strict");
  });

  it("only treats plain look-only commands as safe", () => {
    for (const ok of ["ls", "ls -la src", "pwd", "git status", "git diff src/a.ts", "git log --oneline -n 5", "node -v", "cargo --version"]) {
      expect(isSafeCommand(ok), ok).toBe(true);
    }
    for (const bad of [
      "ls; rm -rf x", "ls && touch a", "ls | sh", "ls > out.txt", "ls $(whoami)", "ls ~/Documents", "ls /etc", "ls ../other",
      "ls *.ts", "git push", "git diff --output=x", "git diff --ext-diff", "git log --exec=x", "node -e 1", "rm --version x", "./run --version",
      "pwd -P", "cat ~/.zshrc", "",
    ]) {
      expect(isSafeCommand(bad), bad).toBe(false);
    }
  });

  it("caps web searches per task", async () => {
    const env = { cwd: "/p", home: "/Users/me", signal: new AbortController().signal, webSearch: async () => "results", searches: MAX_SEARCHES_PER_TASK };
    const capped = await executeTool("web_search", { query: "x" }, env);
    expect(capped.ok).toBe(false);
    expect(capped.output).toContain("Search limit reached");
  });

  it("spots commands that delete", () => {
    for (const cmd of ["rm a", "rm -rf build", "cd x && rm a", "sudo rm a", "rmdir d", "find . -name x -delete", "git clean -fd", "trash a"]) {
      expect(isDeleteCommand(cmd), cmd).toBe(true);
    }
    for (const cmd of ["npm run format", "git status", "echo firm", "npm i rimraf"]) expect(isDeleteCommand(cmd), cmd).toBe(false);
  });

  it("describes actions in plain words", () => {
    expect(describeTool("find_files", { pattern: "E.V", everywhere: true })).toBe('Search this Mac for "E.V"');
    expect(describeTool("edit_file", { path: "a.ts" })).toBe("Edit a.ts");
  });
});

describe("system prompt", () => {
  const context = {
    globalRules: "## RULES\n- No fluff",
    projectRules: null,
    summary: "Built with Tauri",
    skills: [
      { name: "caveman", description: "Short replies", path: "/s/caveman", claudeOnly: false },
      { name: "computer-use", description: "Control apps", path: "/s/cu", claudeOnly: true },
    ],
    cwd: "/p/app",
    home: "/Users/me",
  };

  it("carries the user's rules, skills and approval behaviour", () => {
    const prompt = buildSystemPrompt({ modelLabel: "Gemini 3.5 Flash", context, userSystemPrompt: "", now: new Date(2026, 9, 8) });
    expect(prompt).toContain("Project folder: /p/app");
    expect(prompt).toContain("- No fluff");
    expect(prompt).toContain("- caveman: Short replies");
    expect(prompt).toContain("Claude-only skills");
    expect(prompt).toContain("computer-use");
    expect(prompt).toContain("always get their own approval with a preview");
    expect(prompt).toContain("Never say you can't open");
    expect(prompt).not.toContain("- computer-use:");
  });

  it("adds SUMMARY.md only when present", () => {
    expect(summaryContext("Built with Tauri")).toContain("SUMMARY.md");
    expect(summaryContext(null)).toBeUndefined();
  });
});

describe("adapters", () => {
  it("echoes Gemini call ids in function responses only when Gemini supplied them", () => {
    const [item] = geminiAdapter.toolResults([
      { call: { id: "call_9", name: "list_directory", args: {} }, output: "a" },
      { call: { id: "call-abc", name: "read_file", args: {} }, output: "b" },
    ]) as { parts: { functionResponse: Record<string, unknown> }[] }[];
    expect(item.parts[0].functionResponse).toEqual({ name: "list_directory", id: "call_9", response: { result: "a" } });
    expect(item.parts[1].functionResponse).toEqual({ name: "read_file", response: { result: "b" } });
  });

  it("trims big tool outputs before saving a transcript", () => {
    const items = [{ role: "user", parts: [{ functionResponse: { name: "x", response: { result: "z".repeat(10_000) } } }] }];
    const [compact] = compactTranscript("gemini", items, 100) as typeof items;
    expect(compact.parts[0].functionResponse.response.result.length).toBeLessThan(200);
    const [tool] = compactTranscript("groq", [{ role: "tool", tool_call_id: "1", content: "y".repeat(500) }], 100) as { content: string }[];
    expect(tool.content.length).toBeLessThan(200);
  });
});
