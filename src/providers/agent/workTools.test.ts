import { describe, expect, it } from "vitest";
import type { DocRead } from "../../lib/ipc";
import { compactTranscript, geminiAdapter, picturesOf, type ToolCall } from "./adapters";
import { categoryFor, decide, DEFAULT_LEVELS, type PolicyContext } from "./policy";
import { agentTools, parseAgentJob } from "./subagents";
import { approvalFor, describeTool, isSafeCommand, TOOL_DEFINITIONS } from "./tools";
import { assembleParts, htmlWords, unreadPages } from "./workTools";
import { executeTool, type ToolEnv } from "./tools";
import { documentChecks, documentScript, formatDocument, isDocumentPath, KEEP_DETAILS, looksLikeMath, missingTopics, parseQuestion, rawMathLeft, typesetMath } from "./workTools";
import { keepRecentPictures } from "../../services/jobs";
import { splitForCompaction, transcriptText } from "../../services/compaction";
import { verifyPrompt } from "../../services/chatRunner";
import type { ChatMessage } from "../../types";

const ctx: PolicyContext = { cwd: "/p/app", home: "/Users/me", hasProject: true, readLocal: false, taskApps: new Set(), neverApps: [] };

describe("documents", () => {
  it("opens PDFs, pictures and office files as documents, everything else as text", () => {
    for (const p of ["notes.pdf", "~/Downloads/Final Cheat  (1).PDF", "scan.HEIC", "deck.pptx", "budget.xlsx", "essay.docx", "plan.pages"]) expect(isDocumentPath(p)).toBe(true);
    for (const p of ["main.rs", "README.md", "data.csv", "notes.txt", "pdf"]) expect(isDocumentPath(p)).toBe(false);
  });

  it("gives the model every page's words, the words in its pictures, and the pictures", () => {
    const doc: DocRead = {
      path: "/Users/me/Downloads/cheat.pdf",
      kind: "pdf",
      pageCount: 36,
      text: "",
      note: "Read pages 1–2 of 36.",
      pages: [
        { number: 1, text: "Power Functions", ocr: "Each of the parent functions is a power function", image: "AAA", blank: 0 },
        { number: 2, text: "", ocr: "", image: "BBB", blank: 0 },
      ],
    };
    const out = formatDocument(doc);
    expect(out.output).toContain("PDF, 36 pages");
    expect(out.output).toContain("--- Page 1 ---\nPower Functions");
    expect(out.output).toContain("Each of the parent functions is a power function");
    expect(out.output).toContain("(no words found — look at the picture)");
    expect(out.output).toContain("Pictures attached, in order: Page 1, Page 2");
    expect(out.output).toContain("Read pages 1–2 of 36.");
    expect(out.images).toEqual(["AAA", "BBB"]);
    expect(out.display).toBe("cheat.pdf · PDF · 36 pages · pages 1–2");
  });

  it("labels slides and pictures found inside office files", () => {
    const out = formatDocument({ path: "/d/deck.pptx", kind: "slides", pageCount: 2, text: "", note: "", pages: [{ number: 1, text: "Intro", ocr: "", image: "", blank: 0 }, { number: 0, text: "", ocr: "chart words", image: "CCC", blank: 0 }] });
    expect(out.output).toContain("Slides, 2 slides");
    expect(out.output).toContain("--- Slide 1 ---\nIntro");
    expect(out.output).toContain("--- Picture inside the file ---");
  });
});

describe("checking a made document against its source", () => {
  const source = [
    "--- Page 1 ---",
    "Horizontal Line Test",
    "If any horizontal line crosses the graph twice, it is not one-to-one.",
    "Inflection Point",
    "This set of functions includes any",
    "function that can be represented as a power",
    "Interval Notation",
    "Show My Answer",
    "Text description for parabola graph",
    "Observe the mapping diagram of",
    "Keep these features in mind",
    "The equation can take the",
    "Pictures attached, in order: Page 1",
  ].join("\n");

  it("lists headings whose content is gone", () => {
    expect(missingTopics([source], "Horizontal line test: a function is one-to-one if no horizontal line crosses it twice.")).toEqual(["Inflection Point", "Interval Notation"]);
  });

  it("isn't fooled by PDF text split inside words", () => {
    expect(missingTopics(["Inflection Point\nnext line"], "the infl ection p oint is (0,0)")).toEqual([]);
  });

  it("ignores buttons, captions, page labels and wrapped sentences", () => {
    expect(missingTopics([source], "horizontal line test inflection point interval notation")).toEqual([]);
  });
});

describe("document quality checks", () => {
  const preview = (blanks: number[]): DocRead => ({ path: "/p/a.pdf", kind: "pdf", pageCount: blanks.length, text: "", note: "", pages: blanks.map((blank, i) => ({ number: i + 1, text: "", ocr: "", image: "X", blank })) });

  it("typesets LaTeX as MathML and leaves prices, scripts and styles alone", () => {
    const out = typesetMath("<p>\\(x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\\)</p><p>It costs $5 and $6.</p>$$y=kx$$<style>.a{content:'\\(no\\)'}</style>");
    expect(out).toContain("<math");
    expect(out).toContain("<mfrac>");
    expect(out).toContain('display="block"');
    expect(out).toContain("It costs $5 and $6.");
    expect(out).toContain("<style>.a{content:'\\(no\\)'}</style>");
    expect(typesetMath("a &lt; b: \\(a &lt; b\\)")).toContain("<mo>&lt;</mo>");
  });

  it("typesets single-dollar math the way models usually write it, but not prices", () => {
    const out = typesetMath("<li>Domain: $x \\ge -2$ ($[-2, \\infty)$)</li><li>Rewrite $f(x)$ as $y$.</li><p>Tickets cost $5 and $12.50 each.</p>");
    expect(out).not.toContain("\\ge");
    expect(out).not.toContain("\\infty");
    expect(out).not.toContain("$y$");
    expect((out.match(/<math/g) ?? []).length).toBe(4);
    expect(out).toContain("Tickets cost $5 and $12.50 each.");
    expect(looksLikeMath("5")).toBe(false);
    expect(looksLikeMath("x")).toBe(true);
    expect(looksLikeMath("f(x)")).toBe(true);
    expect(looksLikeMath("\\sqrt{x+2}")).toBe(true);
    expect(looksLikeMath("k > 0")).toBe(true);
    expect(looksLikeMath("a, b, h, k")).toBe(true);
    expect(looksLikeMath("x &lt; 3")).toBe(true);
    expect(looksLikeMath("price > cost")).toBe(false);
    expect(typesetMath("<li>up $k > 0$</li>")).toContain("<math");
    expect(typesetMath("<b>$x</b> and <i>y$</i>")).not.toContain("<math");
  });

  it("notices math code left in a finished document", () => {
    expect(rawMathLeft("Range: $y \\ge 0$ and \\sqrt{x}")).toEqual(["$y \\ge 0$", "\\sqrt"]);
    expect(rawMathLeft("Range: y ≥ 0 costs $5")).toEqual([]);
  });

  it("sends document scripts to E.V's own tools unless the user named the tool", () => {
    expect(documentScript("python3 -c \"from pypdf import PdfReader\"", "what's on page 26?")).toBe("pypdf");
    expect(documentScript("python3 make.py  # uses reportlab", "make a pdf")).toBe("reportlab");
    expect(documentScript("pdftotext a.pdf -", "use pdftotext on it")).toBeNull();
    expect(documentScript("npm test", "run tests")).toBeNull();
  });

  it("knows when the user asked to keep every detail", () => {
    for (const t of ["make it smaller but don't lose any of the details", "not remove all the details", "keep everything, just shorter", "without losing anything"]) expect(KEEP_DETAILS.test(t)).toBe(true);
    for (const t of ["summarize this in 5 bullets", "make a one page summary"]) expect(KEEP_DETAILS.test(t)).toBe(false);
  });

  it("mentions empty space only when content is missing or the text is tiny", () => {
    expect(documentChecks(preview([0.55, 0.6]), "", [], "").notes).toEqual([]);
    const tiny = documentChecks(preview([0.48]), "", [], "", 0.6);
    expect(tiny.notes[0]).toBe("Empty space: page 1 is 48% empty at the bottom — use it for any content that's missing.");
  });

  it("fails text too small to print", () => {
    const tinyText = documentChecks(preview([0.1]), "", [], "", 0.6);
    expect(tinyText.problems).toEqual(["60% of the text is too small to read when printed"]);
    expect(documentChecks(preview([0.1]), "", [], "", 0.05).problems).toEqual([]);
  });

  it("says how much of the source was kept, and pushes back when details were asked for", () => {
    const source = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(" ");
    const thin = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
    const keep = documentChecks(preview([0]), thin, [source], "make it shorter but don't lose the details");
    expect(keep.notes[0]).toContain("you kept 5%");
    expect(keep.notes[0]).toContain("content is missing");
    expect(keep.problems).toEqual(["only 5% of the source's content is in it, but the user asked to keep the details"]);
    const summary = documentChecks(preview([0]), thin, [source], "summarize it");
    expect(summary.notes[0]).toContain("you kept 5%");
    expect(summary.notes[0]).not.toContain("content is missing");
    expect(summary.problems).toEqual([]);
  });
});

describe("look-only commands", () => {
  it("lets agents count and peek at project files without a card", () => {
    for (const c of ["wc -w b.txt", "wc -l src/a.ts", "head -20 notes.txt", "tail -n 5 log.txt", "cat README.md", "file photo.png"]) expect(isSafeCommand(c)).toBe(true);
    for (const c of ['echo "Checking Venmo"', "echo hello world"]) expect(isSafeCommand(c)).toBe(true);
    for (const c of ['echo "x" > a.txt', "echo $(whoami)", "echo hi; rm a", 'echo "`id`"', "echo ~"]) expect(isSafeCommand(c)).toBe(false);
    for (const c of ["cat ~/.ssh/id_rsa", "cat /etc/passwd", "wc -w ../secret.txt", "cat", "head -c 10 a > b", "cat a.txt | sh"]) expect(isSafeCommand(c)).toBe(false);
  });
});

describe("documents written in parts", () => {
  it("collects parts per document, can rewrite one, and assembles them in the print layout", async () => {
    const env: ToolEnv = { cwd: "/p", home: "/Users/me", webSearch: async () => "", signal: new AbortController().signal };
    const a = await executeTool("document_part", { path: "notes.pdf", html: "<h2>Inverses</h2><p>Swap x and y, then solve for y.</p>" }, env);
    expect(a.output).toContain("Part 1 saved (9 words)");
    await executeTool("document_part", { path: "/p/notes.pdf", html: "<h2>Composition</h2><p>Inside first.</p>" }, env);
    const fixed = await executeTool("document_part", { path: "notes.pdf", html: "<h2>Composition</h2><p>Evaluate the inside function first.</p>", replace: 2 }, env);
    expect(fixed.output).toContain("has 2 parts");
    expect(env.documentParts?.["/p/notes.pdf"]).toHaveLength(2);
    expect((await executeTool("document_part", { path: "notes.pdf", html: "<p>x</p>", replace: 5 }, env)).ok).toBe(false);
    const html = assembleParts(env.documentParts!["/p/notes.pdf"], "Unit 5");
    expect(html).toContain("<h1>Unit 5</h1>");
    expect(html).toContain("column-count: 2");
    expect(html.indexOf("Inverses")).toBeLessThan(html.indexOf("Evaluate the inside"));
    expect(htmlWords("<h2>A b</h2><style>x{}</style><p>c d e</p>")).toBe(5);
  });
});

describe("half-read sources", () => {
  it("lists the pages of each PDF never read", () => {
    expect(unreadPages({ "/d/Final Cheat.pdf": { total: 36, read: Array.from({ length: 20 }, (_, i) => i + 1) } })).toEqual(["Final Cheat.pdf: pages 21–36"]);
    expect(unreadPages({ "/d/a.pdf": { total: 5, read: [1, 2, 4] } })).toEqual(["a.pdf: pages 3, 5"]);
    expect(unreadPages({ "/d/a.pdf": { total: 2, read: [2, 1] } })).toEqual([]);
    // Only the pages the user asked about count.
    const read = { "/d/Final Cheat.pdf": { total: 36, read: [9, 10, 11, 12, 13, 14, 15, 16] } };
    expect(unreadPages(read, "Make a PDF covering pages 9–16 of that cheat sheet")).toEqual([]);
    expect(unreadPages(read, "covering pages 9 to 18")).toEqual(["Final Cheat.pdf: pages 17–18"]);
  });
});

describe("making documents and other new tools", () => {
  it("treats making a document like writing a file", () => {
    expect(categoryFor("make_document", { path: "notes.pdf", html: "<p>x</p>" }, ctx)).toBe("edit_project");
    expect(categoryFor("make_document", { path: "~/Desktop/notes.pdf", html: "<p>x</p>" }, ctx)).toBe("outside_files");
    expect(approvalFor("make_document", { path: "notes.pdf" }, { ...ctx })).toBe("ask");
    expect(approvalFor("make_document", { path: "~/Desktop/a.pdf" }, { ...ctx })).toBe("strict");
    expect(describeTool("make_document", { path: "~/Desktop/a.pdf" })).toBe("Make ~/Desktop/a.pdf");
  });

  it("runs questions, sub-agents and reading background output without a card", () => {
    for (const name of ["ask_user", "agent", "command_output", "command_stop"]) {
      expect(categoryFor(name, {}, ctx)).toBe("internal");
      expect(decide("internal", DEFAULT_LEVELS, null, name, {}, ctx)).toBe("run");
    }
    // Starting something in the background is still a command: it asks like any other.
    expect(categoryFor("run_command", { command: "npm run dev", background: true }, ctx)).toBe("scripts");
    expect(describeTool("run_command", { command: "npm run dev", background: true })).toBe("Run in the background");
  });

  it("offers every new tool to the model", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    for (const name of ["make_document", "command_output", "command_stop", "ask_user", "agent"]) expect(names).toContain(name);
    const read = TOOL_DEFINITIONS.find((t) => t.name === "read_file")!;
    expect(read.parameters.properties.pages).toBeDefined();
    expect(TOOL_DEFINITIONS.find((t) => t.name === "run_command")!.parameters.properties.background).toBeDefined();
  });

  it("parses questions with 2+ choices", () => {
    expect(parseQuestion({ question: "Which file?", options: [{ label: "A (Recommended)", description: "newer" }, "B"] })).toEqual({
      question: "Which file?",
      options: [{ label: "A (Recommended)", description: "newer" }, { label: "B" }],
      multi: false,
    });
    expect(parseQuestion({ question: "Which?", options: ["only one"] })).toBeNull();
    expect(parseQuestion({ question: "", options: ["a", "b"] })).toBeNull();
  });
});

describe("sub-agents", () => {
  it("only get look-up tools, never ones that change things or talk to the user", () => {
    for (const type of ["explore", "research", "general"] as const) {
      const names = agentTools(type, TOOL_DEFINITIONS).map((t) => t.name);
      for (const banned of ["write_file", "edit_file", "make_document", "agent", "ask_user", "propose_plan", "remember", "mac_click", "mac_type", "mac_open"]) expect(names).not.toContain(banned);
      expect(names).toContain(type === "research" ? "web_search" : "read_file");
    }
    expect(agentTools("explore", TOOL_DEFINITIONS).map((t) => t.name)).not.toContain("web_search");
  });

  it("parses a briefing", () => {
    expect(parseAgentJob({ description: "Find approvals", prompt: "Where are approvals decided?", type: "explore" })).toEqual({ description: "Find approvals", prompt: "Where are approvals decided?", type: "explore" });
    expect(parseAgentJob({ prompt: "Research X", type: "weird" })?.type).toBe("general");
    expect(parseAgentJob({ description: "x" })).toBeNull();
  });
});

describe("pictures", () => {
  const call: ToolCall = { id: "c1", name: "read_file", args: {} };

  it("sends every page picture to Gemini, in order", () => {
    const [content] = geminiAdapter.toolResults([{ call, output: "ok", images: ["P1", "P2"] }]) as { parts: Record<string, unknown>[] }[];
    const data = content.parts.filter((p) => p.inlineData).map((p) => (p.inlineData as { data: string }).data);
    expect(data).toEqual(["P1", "P2"]);
    expect(content.parts.some((p) => p.text === "Picture 2 of 2 from read_file:")).toBe(true);
    expect(picturesOf({ call, output: "", image: "A", images: ["B"] })).toEqual(["A", "B"]);
  });

  it("keeps only the latest pictures in a task, for both wire formats", () => {
    const gem = (d: string) => ({ role: "user", parts: [{ inlineData: { mimeType: "image/jpeg", data: d } }] });
    const oai = (d: string) => ({ role: "user", content: [{ type: "image_url", image_url: { url: d } }] });
    const kept = keepRecentPictures("gemini", [gem("1"), oai("2"), gem("3")], 2) as { parts?: { text?: string }[]; content?: unknown }[];
    expect(kept[0].parts?.[0].text).toBe("[older picture removed]");
    expect(JSON.stringify(kept[1])).toContain("image_url");
    expect(JSON.stringify(kept[2])).toContain("inlineData");
    const saved = compactTranscript("groq", [oai("x")]) as { content: { type: string }[] }[];
    expect(saved[0].content[0].type).toBe("text");
  });
});

describe("long chats and checking work", () => {
  const msg = (role: "user" | "assistant", i: number): ChatMessage => ({ id: `m${i}`, role, content: `${role} ${i}`, createdAt: i });

  it("folds older messages and keeps a recent tail that starts with the user", () => {
    const list = Array.from({ length: 50 }, (_, i) => msg(i % 2 ? "assistant" : "user", i));
    const { fold, recent } = splitForCompaction(list, 16);
    expect(fold.length + recent.length).toBe(50);
    expect(recent[0].role).toBe("user");
    expect(recent.length).toBeLessThanOrEqual(16);
    expect(fold.at(-1)!.id).toBe(`m${49 - recent.length}`);
  });

  it("writes a transcript with actions and their results", () => {
    const m: ChatMessage = {
      ...msg("assistant", 1),
      content: "Made it.",
      blocks: [{ type: "tool", step: { id: "s", name: "make_document", args: {}, title: "Make ~/Desktop/a.pdf", status: "done", needsApproval: true, result: "a.pdf · 4 pages" } }],
    };
    expect(transcriptText([msg("user", 0), m])).toBe("User: user 0\n\nE.V: Made it.\n  • Make ~/Desktop/a.pdf — done: a.pdf · 4 pages");
  });

  it("reminds the AI to compare with the request and run the build", () => {
    const text = verifyPrompt("make this pdf smaller", ["~/Desktop/a.pdf"], true);
    expect(text).toContain('"make this pdf smaller"');
    expect(text).toContain("~/Desktop/a.pdf");
    expect(text).toContain("no fact, example, number or section from the source was lost");
    expect(text).toContain("type-check, build or tests");
    expect(verifyPrompt("x", [], false)).not.toContain("type-check");
  });
});

describe("condensing in page groups", async () => {
  const { pageGroups, wantedPages, cleanFragment } = await import("./condense");
  it("splits pages into small groups and respects a page range", () => {
    expect(pageGroups(wantedPages(undefined, 7))).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    expect(wantedPages("9-12", 36)).toEqual([9, 10, 11, 12]);
    expect(wantedPages("1,3,40", 36)).toEqual([1, 3]);
  });
  it("keeps only the HTML fragment the model wrote", () => {
    expect(cleanFragment("```html\n<html><body><h2>Inverses</h2><style>x{}</style></body></html>\n```")).toBe("<h2>Inverses</h2>");
  });
});

describe("what 'this' means", async () => {
  it("treats a bare 'this' as what's on screen, but not 'this folder'", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("../../services/chatRunner.ts", import.meta.url), "utf8");
    const deictic = new RegExp(/const DEICTIC = \/(.+)\/i;/.exec(src)![1], "i");
    for (const t of ["what is this about?", "explain that", "summarize these", "fix it here"]) expect(deictic.test(t)).toBe(true);
    for (const t of ["save it as cheat-short.pdf in this folder", "what did we do this week", "this is great", "make a pdf in this project"]) expect(deictic.test(t)).toBe(false);
  });
});

describe("scripts that only open an app", () => {
  it("count as opening, anything more is still a script", () => {
    expect(categoryFor("mac_applescript", { script: 'tell application "Discord" to activate' }, ctx)).toBe("open");
    expect(categoryFor("mac_applescript", { script: 'tell application "Discord" to activate\ndo shell script "rm -rf ~"' }, ctx)).not.toBe("open");
    expect(categoryFor("mac_applescript", { script: 'tell application "Music" to play' }, ctx)).toBe("scripts");
  });
});

describe("make_document after condensing", () => {
  it("uses the parts when the model forgets from_parts", async () => {
    const { makeDocument } = await import("./workTools");
    // No parts and no HTML is still an error…
    expect((await makeDocument("/p", { path: "a.pdf" }, "")).output).toContain("html is empty");
  });
});

describe("fitting a page count", async () => {
  const { wantedPageCount, scaled } = await import("./workTools");
  it("reads the page count the user asked for", () => {
    expect(wantedPageCount("Make a 2-page PDF on my Desktop")).toBe(2);
    expect(wantedPageCount("fit it on one page")).toBe(1);
    expect(wantedPageCount("make it two pages long")).toBe(2);
    expect(wantedPageCount("covering pages 9–16 of that cheat sheet")).toBeNull();
    expect(wantedPageCount("page 4 of the notes")).toBeNull();
  });
  it("scales the layout with CSS zoom", () => {
    expect(scaled("<html><head><title>x</title></head><body></body></html>", 0.9)).toContain("<style>html{zoom:0.9}</style></head>");
    expect(scaled("<p>x</p>", 0.8)).toBe("<style>html{zoom:0.8}</style><p>x</p>");
  });
});

describe("the no-examples rule", async () => {
  const { NO_EXAMPLES, KEEP_DETAILS: KEEP } = await import("./workTools");
  it("knows when examples aren't allowed", () => {
    for (const t of ["no examples at all", "remember the rule that no examples are allowed", "the pdf can not have examples on it", "don't include examples"]) expect(NO_EXAMPLES.test(t)).toBe(true);
    for (const t of ["keep every example", "add an example"]) expect(NO_EXAMPLES.test(t)).toBe(false);
    expect(KEEP.test("Keep every definition, rule, formula, property and graph feature")).toBe(true);
  });
  it("fails a document that still has examples", () => {
    const doc: DocRead = { path: "/p/a.pdf", kind: "pdf", pageCount: 1, text: "", note: "", pages: [{ number: 1, text: "", ocr: "", image: "X", blank: 0.1 }] };
    const out = documentChecks(doc, "One-to-one. Examples: all linear functions.", [], "make a guide, no examples at all");
    expect(out.problems).toEqual(["the user said no examples, but it has “Examples”"]);
    expect(documentChecks(doc, "One-to-one: all linear functions are one-to-one.", [], "make a guide, no examples at all").problems).toEqual([]);
    expect(documentChecks(doc, "restrict the domain (e.g., x ≥ 0)", [], "no examples").problems).toEqual(["the user said no examples, but it has “e.g.”"]);
  });
});
