import { gbDesmos, gbDo, gbLook, gbOpen, gbTabs, type BrowserStep, type PageView } from "../../lib/ipc";
import { openBrowserPanel } from "../../services/browserPanel";
import { analyzeGraph, describeGraph, readGraphInput, type GraphResult } from "./graph";
import type { ToolDefinition } from "./tools";

/**
 * The E.V Browser: E.V's own hidden copy of Vivaldi with its own logins (never the user's
 * Vivaldi). Pages come back as text — numbered controls plus the page's words — so most steps need
 * no picture, and several steps go in one call.
 */

export const BROWSER_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "browser_go",
    description:
      "Open a web page in the E.V Browser — your own hidden browser with its own Google account (not the user's Vivaldi). Returns the page as text: numbered controls (#id) and the page's words. Use it for anything on the web that needs clicking, typing, signing in or a real page; for just reading an article, web_fetch is lighter.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Address, e.g. 'https://www.youtube.com/results?search_query=lofi' — go straight to the right page (search URLs, deep links) instead of clicking there" },
        picture: { type: "boolean", description: "Also return a picture — only when the look matters (images, charts, layout)" },
        tab: { type: "string", description: "Only for a tab the user shared with you (e.g. 'user-2'); leave empty for your own tab" },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_do",
    description:
      "Do several steps in the E.V Browser in one go, then get the page back as text. Plan the whole sequence from the last page you saw: e.g. [{do:'type', id:4, text:'lofi beats', submit:true}, {do:'click', id:12}]. Steps: go {url} · click {id} · type {id, text, clear (default true), submit} · key {key, modifiers} · select {id, value} · scroll {dy: lines, negative = up} · wait {ms} · back. Ids come from the last page you saw; after a page changes, use the new ids. It stops at the first step that fails and tells you why.",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "Steps in order",
          items: {
            type: "object",
            properties: {
              do: { type: "string", enum: ["go", "click", "type", "key", "select", "scroll", "wait", "back"], description: "What to do" },
              id: { type: "integer", description: "Control number (#id)" },
              text: { type: "string", description: "Text to type" },
              submit: { type: "boolean", description: "Press Enter after typing" },
              clear: { type: "boolean", description: "Replace what's in the field (default true)" },
              key: { type: "string", description: "Key: enter, tab, escape, up, down, a–z…" },
              modifiers: { type: "array", items: { type: "string" }, description: "command, shift, option, control" },
              value: { type: "string", description: "Option to choose" },
              url: { type: "string", description: "Page to open" },
              dy: { type: "integer", description: "Scroll lines" },
              ms: { type: "integer", description: "Milliseconds to wait (max 8000)" },
            },
            required: ["do"],
          },
        },
        picture: { type: "boolean", description: "Also return a picture of the result" },
        tab: { type: "string", description: "Only for a tab the user shared with you (e.g. 'user-2'); leave empty for your own tab" },
      },
      required: ["steps"],
    },
  },
  {
    name: "browser_look",
    description: "Read the E.V Browser's current page again (as text; picture only if asked). With tab, read a tab the user shared with you.",
    parameters: {
      type: "object",
      properties: {
        picture: { type: "boolean", description: "Also return a picture" },
        tab: { type: "string", description: "A tab the user shared with you (e.g. 'user-2'); leave empty for your own tab" },
      },
    },
  },
  {
    name: "browser_show",
    description: "Show your E.V Browser tab in E.V's Browser panel so the user can see it or take over (e.g. to type a password). Only when the user asks to see it.",
    parameters: { type: "object", properties: { show: { type: "boolean", description: "true to show, false to hide" } }, required: ["show"] },
  },
  {
    name: "make_graph",
    description:
      "Draw a graph right in the chat (instant, no browser) and get its roots, solutions, intersections, turning points and y-intercept computed exactly. Use it for any 'graph / plot / find the root / where do they meet' request, including equations read from a picture. Set open_desmos only if the user asked for Desmos — it then opens Desmos with the same graph in the E.V Browser and shows it.",
    parameters: {
      type: "object",
      properties: {
        expressions: { type: "array", items: { type: "string" }, description: "Curves 'y = x^3 - 2x - 5' or plain 'x^3 - 2x - 5', or equations in x like 'x^2 = 4'. Use ^ for powers, sqrt(), |x|, sin(), ln(), pi." },
        x_from: { type: "number", description: "Optional left edge" },
        x_to: { type: "number", description: "Optional right edge" },
        open_desmos: { type: "boolean", description: "Also open it in Desmos (only when the user asked for Desmos)" },
      },
      required: ["expressions"],
    },
  },
];

export const BROWSER_TOOLS = new Set(BROWSER_TOOL_DEFINITIONS.map((t) => t.name).filter((n) => n !== "make_graph"));

// ── Personal details: typing them into a website always asks ─────────────────

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /(?:\+?\d[\s().-]*){10,}/;
const STREET = /\b\d{1,6}\s+(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Ter|Terrace|Pkwy|Parkway)\b/;
const ID_NUMBER = /\b\d{3}-\d{2}-\d{4}\b/;

/** Why some text looks like the user's personal details, or null. */
export function personalInfo(text: string): string | null {
  if (EMAIL.test(text)) return "an email address";
  if (ID_NUMBER.test(text)) return "an ID number";
  if (PHONE.test(text)) return "a phone number";
  if (STREET.test(text)) return "a street address";
  return null;
}

export function stepsOf(args: Record<string, unknown>): BrowserStep[] {
  return (Array.isArray(args.steps) ? args.steps : []).filter((s): s is BrowserStep => typeof s === "object" && s !== null && typeof (s as BrowserStep).do === "string");
}

/** What a browser action would type that needs the user's yes, or null. */
export function browserPersonal(name: string, args: Record<string, unknown>, readLocal: boolean): string | null {
  if (name !== "browser_do") return null;
  for (const step of stepsOf(args)) {
    if (step.do !== "type" || !step.text) continue;
    if (readLocal) return "typing into a website after reading your files";
    const what = personalInfo(step.text);
    if (what) return `typing ${what} into a website`;
  }
  return null;
}

/** Web addresses an action opens (for the "after reading your files" check). */
export function browserUrls(name: string, args: Record<string, unknown>): string[] {
  if (name === "browser_go") return [String(args.url ?? "")];
  if (name === "browser_do") return stepsOf(args).filter((s) => s.do === "go").map((s) => s.url ?? "");
  return [];
}

// ── Running them ──────────────────────────────────────────────────────────────

export interface BrowserOutcome {
  output: string;
  display: string;
  ok: boolean;
  image?: string;
  graph?: GraphResult;
}

function refusal(reason: string): BrowserOutcome | null {
  if (reason.startsWith("NEVER:money")) {
    return { output: "Refused: that page or button involves money (paying, buying, banking, checkout). E.V never does it — tell the user to do this part themselves.", display: "Refused — money is never handled by E.V", ok: false };
  }
  if (reason.startsWith("NEVER:private")) {
    return { output: "Refused: that's one of the user's private browser tabs. Ask them to click the share button on the tab if they want you to see it.", display: "Refused — that tab is private", ok: false };
  }
  if (reason.startsWith("NEVER:password")) {
    return { output: "Refused: that's a password, security code or card field. E.V never types those — tell the user to type it themselves (they can use browser_show to see the page).", display: "Refused — passwords and codes are typed by you", ok: false };
  }
  return null;
}

const pageOut = (page: PageView, lead = "") => `${lead}${page.text}`;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export async function executeBrowserTool(name: string, args: Record<string, unknown>, ownTab = "main"): Promise<BrowserOutcome> {
  // The AI's own tab, or a tab the user shared (E.V refuses private ones itself).
  const tab = typeof args.tab === "string" && args.tab.trim() ? args.tab.trim() : ownTab;
  try {
    switch (name) {
      case "browser_go": {
        const page = await gbOpen(String(args.url ?? ""), tab, args.picture === true);
        return { output: pageOut(page), display: `${page.title || page.url} · ${page.controls} controls`, ok: true, image: page.image || undefined };
      }
      case "browser_look": {
        const page = await gbLook(tab, args.picture === true);
        return { output: pageOut(page), display: `${page.title || page.url || "Empty tab"} · ${page.controls} controls`, ok: true, image: page.image || undefined };
      }
      case "browser_do": {
        const steps = stepsOf(args);
        if (!steps.length) return { output: "No steps given.", display: "No steps", ok: false };
        const out = await gbDo(steps, tab, args.picture === true);
        const refused = out.stopped ? refusal(out.stopped) : null;
        const lead = [
          out.done.length ? `Done: ${out.done.join(" → ")}.` : "",
          refused ? refused.output : out.stopped ? `Stopped at ${out.stopped}. The steps after it didn't run.` : "",
        ]
          .filter(Boolean)
          .join("\n");
        return {
          output: pageOut(out.page, `${lead}\nNow:\n`),
          display: refused ? refused.display : out.stopped ? `${out.done.length}/${steps.length} steps · stopped: ${out.stopped}` : `${steps.length} steps · ${out.page.title || out.page.url}`,
          ok: !out.stopped,
          image: out.page.image || undefined,
        };
      }
      case "browser_show": {
        if (args.show !== false) openBrowserPanel(tab);
        return { output: args.show === false ? "OK." : "It's showing in E.V's Browser panel now; the user can watch or take over there.", display: args.show === false ? "OK" : "Shown in the Browser panel", ok: true };
      }
      case "make_graph": {
        const lines = (Array.isArray(args.expressions) ? args.expressions : [args.expressions]).map((e) => String(e ?? ""));
        const from = num(args.x_from);
        const to = num(args.x_to);
        const graph = analyzeGraph(readGraphInput(lines), from !== undefined && to !== undefined && to > from ? [from, to] : undefined);
        let note = "";
        if (args.open_desmos === true) {
          const v = graph.view;
          note = await gbDesmos([...graph.input.curves.map((c) => c.latex), ...graph.input.equations.map((e) => e.latex)], [v.xmin, v.xmax, v.ymin, v.ymax])
            .then(() => (openBrowserPanel("desmos"), "\nDesmos is open in E.V's Browser panel with the same graph."))
            .catch((err) => `\nCouldn't open Desmos: ${String(err)}. The graph in the chat still works.`);
        }
        return { output: describeGraph(graph) + note, display: lines.join(" · "), ok: true, graph };
      }
      default:
        return { output: `Unknown browser tool ${name}.`, display: "", ok: false };
    }
  } catch (err) {
    const message = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
    return refusal(message) ?? { output: `Error: ${message}`, display: message, ok: false };
  }
}

export function describeBrowserTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "browser_go":
      return `Open ${String(args.url ?? "")} in the E.V Browser`;
    case "browser_look":
      return "Read the E.V Browser's page";
    case "browser_do": {
      const steps = stepsOf(args);
      const said = steps.map((s) =>
        s.do === "type" ? `type “${(s.text ?? "").slice(0, 40)}”${s.submit ? " ⏎" : ""}` : s.do === "click" ? `click #${s.id}` : s.do === "go" ? `open ${s.url}` : s.do === "key" ? `press ${[...(s.modifiers ?? []), s.key].join("+")}` : s.do,
      );
      return `E.V Browser: ${said.join(" → ")}`;
    }
    case "browser_show":
      return args.show === false ? "Hide the E.V Browser" : "Show the E.V Browser";
    case "make_graph":
      return `Graph ${(Array.isArray(args.expressions) ? args.expressions : [args.expressions]).map(String).join(", ")}${args.open_desmos ? " (and open Desmos)" : ""}`;
    default:
      return name;
  }
}

/** Tabs the user shared with the AI, for the system prompt. */
export async function sharedTabsPrompt(): Promise<string> {
  const tabs = (await gbTabs().catch(() => null)) ?? [];
  const shared = tabs.filter((t) => t.mine && t.shared);
  if (!shared.length) return "";
  return [
    "# Tabs the user shared with you",
    "The user is browsing in E.V's Browser panel and shared these tabs. When they say \"this page\", \"my browser tab\" or similar, read it with browser_look and the tab name (and act in it with browser_do, tab name). Their other tabs are private.",
    ...shared.map((t) => `- tab "${t.name}": ${t.title || "(untitled)"} — ${t.url}`),
  ].join("\n");
}
