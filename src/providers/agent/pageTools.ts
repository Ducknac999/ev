import { browserExtensionInstall, browserSwitchOn, pageDo, pageLook, type PageAction, type PageTarget } from "../../lib/ipc";
import { memory, noteBrowser, pickBrowser } from "../../services/browsers";
import type { MacEnv, MacOutcome, ReplayStep } from "./macTools";
import type { ToolDefinition } from "./tools";

/**
 * Web pages in the user's own browser, read and changed from the inside (src-tauri/src/browser):
 * one look lists every control with its label and current value; one page_do runs a whole batch
 * of changes and reports exactly what changed. Any browser works — E.V finds out what it's built
 * on and uses the fastest route it has, or says how to unlock one.
 */

export const PAGE_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "page_look",
    description:
      "Read a web page in the user's own browser from the inside — exact and fast, in the background on any tab (no switching, no screen). Returns numbered controls: label, [words beside it], and current state (on/off, = value, a list's options, colors as #hex). The first choice for anything in the user's browser; mac_look is the fallback. Leave app empty and E.V uses the user's browser (or asks them once).",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "The browser, e.g. 'Ardia' — leave empty for the user's own browser" },
        tab: { type: "string", description: "Words from the tab's title or address, e.g. 'cstimer' — empty = the tab showing" },
        find: { type: "string", description: "Only controls matching these words, e.g. 'color font' — far shorter" },
        text: { type: "boolean", description: "Also return the page's words (articles, results, messages)" },
      },
    },
  },
  {
    name: "page_do",
    description:
      "Do many things on a web page in one step — plan the whole change from one page_look and send it as one batch (up to 60): settings, forms, menus, panels. Each action uses a #number from the last look (ref) or a control's label. Kinds: click {ref} · set {ref, value} (type into a field, a color '#1e1e2e', a number or slider, a checkbox 'on'/'off') · select {ref, option} (any list or dropdown — E.V opens it and picks the option by its words) · check {ref, on} · press {ref, key:'enter'|'escape'|'tab'} · scroll {ref} · wait {ms}. The result lists what changed and the new controls that appeared (an opened menu or panel, with their numbers) — keep going from it without looking again. Popups the page raises (alert / confirm) are answered for you and reported; confirm gets Cancel unless the action has confirm: true (that asks the user first). Each action runs on its own, so the result says exactly which ones worked. Sends and deletes pause for the user's approval; money and password fields are refused.",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "The browser — empty for the user's own" },
        tab: { type: "string", description: "Words from the tab's title or address — empty = the tab showing" },
        actions: {
          type: "array",
          description: "In order; stops at the first one that fails",
          items: {
            type: "object",
            properties: {
              do: { type: "string", enum: ["click", "set", "select", "check", "press", "scroll", "wait"], description: "What to do" },
              ref: { type: "integer", description: "Control number from the last look" },
              label: { type: "string", description: "Instead of ref: the control's label" },
              value: { type: "string", description: "set: the new value" },
              option: { type: "string", description: "select: the option's words" },
              on: { type: "boolean", description: "check: on or off" },
              key: { type: "string", description: "press: enter, escape, tab, up, down" },
              ms: { type: "integer", description: "wait: milliseconds (max 5000)" },
              confirm: { type: "boolean", description: "Answer OK if this action makes the page ask \"are you sure?\" (asks the user first)" },
            },
            required: ["do"],
          },
        },
      },
      required: ["actions"],
    },
  },
];

export const PAGE_TOOLS = new Set(PAGE_TOOL_DEFINITIONS.map((t) => t.name));

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v));

function message(err: unknown): string {
  return typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
}

const SWITCH_NAME = "Allow JavaScript from Apple Events";

function fallback(app: string, why: string): MacOutcome {
  return {
    output: `${why} Work in ${app}'s window instead: mac_tabs (switch with matching), mac_look, then mac_click / mac_do — plan the whole change from one look and batch it with mac_do.`,
    display: why,
    ok: false,
  };
}

/** The browser said its switch is off, the extension is missing, or nothing in it can run E.V's page agent. */
async function routeProblem(err: string, app: string, env: MacEnv, retry: () => Promise<MacOutcome>): Promise<MacOutcome | null> {
  if (err.startsWith("SWITCH_OFF")) {
    const known = memory().known[app];
    if (known?.switch === "declined" || !env.ask) {
      await noteBrowser(app, { switch: known?.switch === "declined" ? "declined" : "off" });
      return fallback(app, `${app} has “${SWITCH_NAME}” off (the user chose not now), so its pages can't be read from the inside.`);
    }
    const answer = await env.ask(
      `To work in ${app}'s pages fast (one step instead of dozens of clicks), ${app} needs “${SWITCH_NAME}” turned on. Should I turn it on? It lets E.V read and change pages only when you ask.`,
      ["Turn it on (Recommended)", "Not now"],
    );
    if (!answer || !/turn/i.test(answer)) {
      await noteBrowser(app, { switch: "declined" });
      return fallback(app, `The user chose not to turn on “${SWITCH_NAME}” in ${app}.`);
    }
    try {
      await browserSwitchOn(app);
      await noteBrowser(app, { switch: "on", route: "script" });
      return await retry();
    } catch (e) {
      await noteBrowser(app, { switch: "off" });
      return fallback(app, `Couldn't turn it on: ${message(e)} Tell the user how (View → Developer → ${SWITCH_NAME}).`);
    }
  }
  if (err.startsWith("NEEDS_EXTENSION")) {
    await noteBrowser(app, { route: "extension" });
    if (!env.ask) return fallback(app, `${app} needs the E.V extension for fast page work.`);
    const answer = await env.ask(`${app} needs the E.V extension so I can work in its pages fast (about 4 clicks, once). Set it up now?`, ["Set it up (Recommended)", "Not now"]);
    if (answer && /set/i.test(answer)) {
      const setup = await browserExtensionInstall(app).catch((e) => ({ folder: "", page: "", steps: [`Couldn't prepare it: ${message(e)}`] }));
      return {
        output: `E.V opened ${app}'s extensions page and the extension's folder. Tell the user these steps exactly, then stop and wait for them:\n${setup.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\nOnce it's added, page_look works in ${app}.`,
        display: `Setting up the E.V extension in ${app}`,
        ok: false,
      };
    }
    return fallback(app, `${app} has no E.V extension yet (the user chose not now).`);
  }
  if (err.startsWith("NO_PAGE_ROUTE")) {
    await noteBrowser(app, { route: "accessibility" });
    return fallback(app, `${app} is built on an engine E.V can't run its page agent in, so it works through the window (slower, still works).`);
  }
  if (err.startsWith("NO_TAB")) {
    return { output: `${err.replace(/^NO_TAB:\s*/, "")}\nIf it isn't open, open it with mac_open (app "${app}", target = its address), then page_look.`, display: "That tab isn't open", ok: false };
  }
  if (err.startsWith("NEVER:money")) {
    return { output: "Refused: this page involves money, which E.V never touches. Tell the user to do this part themselves.", display: "Refused — money is never handled by E.V", ok: false };
  }
  return null;
}

function engineRoute(app: string, engine: string, via: string): void {
  void noteBrowser(app, { ...(engine ? { engine } : {}), route: via, ...(via === "script" ? { switch: "on" as const } : {}), ...(via === "extension" ? { extension: true } : {}) });
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A saved route by words, never by number (numbers change between visits). */
function replayOf(app: string, tab: string, actions: PageAction[], targets: PageTarget[]): ReplayStep[] | null {
  const byWords: PageAction[] = [];
  for (const [i, a] of actions.entries()) {
    if (a.do === "wait") {
      byWords.push({ do: "wait", ms: a.ms });
      continue;
    }
    const t = targets[i];
    const label = t?.own || t?.near || a.label;
    if (!label) return null;
    const { ref: _ref, ...rest } = a;
    byWords.push({ ...rest, label, ...(t?.role ? { role: t.role } : {}) });
  }
  return [{ tool: "page_do", args: { app, tab, actions: byWords } }];
}

function parseActions(raw: unknown): PageAction[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((a) => a && typeof a === "object").map((a) => ({ ...(a as PageAction) }));
}

export async function executePageTool(name: string, args: Record<string, unknown>, env: MacEnv): Promise<MacOutcome> {
  const tab = str(args.tab);
  const pick = await pickBrowser(str(args.app), tab, env.ask ?? null);
  if (!pick) return { output: "No browser found on this Mac. Ask the user which one they use.", display: "No browser found", ok: false };
  const app = pick.name;
  env.noteApp(app);
  const picked = pick.how === "named" || pick.how === "memory" ? "" : ` (${pick.how === "tab" ? `the browser with that tab — remembered for every chat` : pick.how === "asked" ? "the user's choice — remembered" : pick.how === "default" ? "the Mac's default browser" : "the only browser"})`;

  if (name === "page_look") {
    const run = async (): Promise<MacOutcome> => {
      const look = await pageLook(app, tab || undefined, str(args.find) || undefined, args.text === true);
      engineRoute(app, look.engine, look.via);
      const find = str(args.find);
      const counts = find ? `${look.matching ?? look.shown} of ${look.total} controls match “${find}”` : `${look.total} controls${look.shown < look.total ? ` (first ${look.shown}; use find for the rest)` : ""}`;
      const text = look.text ? `\nPage text:\n${look.text}` : "";
      return {
        output: `${app} — page "${look.title}" (${look.url})${picked}\n${counts}\nControls:\n${look.controls.join("\n") || "(none match — look without find)"}${text}`,
        display: `${look.title || host(look.url)} · ${find ? `${look.matching ?? look.shown} matching “${find}”` : `${look.total} controls`}`,
        ok: true,
      };
    };
    try {
      return await run();
    } catch (err) {
      const problem = await routeProblem(message(err), app, env, run);
      if (problem) return problem;
      return { output: `Error: ${message(err)}`, display: message(err), ok: false };
    }
  }

  const actions = parseActions(args.actions);
  if (!actions.length) return { output: "page_do needs actions.", display: "No actions", ok: false };
  const run = async (approved: boolean): Promise<MacOutcome> => {
    const out = await pageDo(app, actions, tab || undefined, approved);
    if (out.verdict === "never") {
      return { output: `Refused: ${out.target} involves money or a password, which E.V never touches. Nothing in this batch ran. Tell the user to do that part themselves.`, display: `Refused — ${out.target}`, ok: false, replay: null };
    }
    if (out.verdict === "final") {
      const kind = /delete|remove|trash|erase|discard/i.test(out.target) ? "delete" : "send";
      const ok = await env.confirmFinal({ kind, title: `${out.target} on ${host(out.url)} in ${app}`, app });
      if (!ok) return { output: `The user did not approve ${out.target}. Nothing in this batch ran. Don't retry it; ask what they'd like instead.`, display: "Not approved", ok: false, replay: null };
      return run(true);
    }
    engineRoute(app, "", out.via);
    const lines: string[] = [];
    if (out.done.length) lines.push(`Done (${out.done.length}/${actions.length}): ${out.done.join("; ")}`);
    if (out.failed) lines.push(`Stopped at action ${(out.failedIndex ?? 0) + 1}: ${out.failed}`);
    if (out.navigated) lines.push(`Now on: "${out.title}" (${out.url})`);
    if (out.changed.length) lines.push(`Changed:\n${out.changed.join("\n")}`);
    if (out.added.length) lines.push(`New on the page:\n${out.added.join("\n")}${out.moreAdded ? `\n…and ${out.moreAdded} more (page_look with find to see them)` : ""}`);
    if (out.removed) lines.push(`${out.removed} controls went away.`);
    if (out.dialogs?.length) lines.push(`The page raised a popup:\n${out.dialogs.join("\n")}`);
    if (out.failed?.startsWith("timed out")) lines.push(`Actions after #${(out.failedIndex ?? 0) + 1} didn't run. mac_look at ${app}'s window to see what's open, deal with it, then page_look before going on.`);
    const visible = out.navigated || out.changed.length > 0 || out.added.length > 0 || out.removed > 0 || (out.dialogs?.length ?? 0) > 0;
    if (!visible && !out.failed) lines.push("The page shows no change — check it worked (page_look with find) before saying it's done.");
    const approvedNote = out.verdict === "approved" ? " (approved by the user)" : "";
    return {
      output: `${app} — after the batch on "${out.title || host(out.url)}"${approvedNote}${picked}\n${lines.join("\n")}`,
      display: out.failed ? `${out.done.length} of ${actions.length} done — ${out.failed}` : `${out.done.length} done${visible ? "" : " · no visible change"}`,
      ok: !out.failed || out.done.length > 0,
      confirmed: out.failed ? false : visible ? true : undefined,
      replay: out.failed || out.verdict === "approved" ? null : replayOf(app, tab, actions, out.targets),
    };
  };
  try {
    return await run(false);
  } catch (err) {
    const problem = await routeProblem(message(err), app, env, () => run(false));
    if (problem) return problem;
    return { output: `Error: ${message(err)}`, display: message(err), ok: false };
  }
}

export function describePageTool(name: string, args: Record<string, unknown>): string {
  const where = [str(args.tab) ? `“${str(args.tab)}”` : "the page", str(args.app) ? `in ${str(args.app)}` : "in your browser"].join(" ");
  if (name === "page_look") return str(args.find) ? `Find “${str(args.find)}” on ${where}` : `Read ${where}`;
  const actions = parseActions(args.actions);
  const kinds = new Set(actions.map((a) => a.do));
  const verb = kinds.size === 1 && kinds.has("click") ? "Click" : kinds.has("set") || kinds.has("select") || kinds.has("check") ? "Change" : "Do";
  return `${verb} ${actions.length} thing${actions.length === 1 ? "" : "s"} on ${where}`;
}
