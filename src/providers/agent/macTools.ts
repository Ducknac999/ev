import {
  macApplescript,
  macClick,
  macClipboard,
  macDrag,
  macMenu,
  macFront,
  macKey,
  macLook,
  macMedia,
  findMyFiles,
  fileOpen,
  macOpen,
  macQuit,
  macScreen,
  macScroll,
  macTabs,
  macShortcut,
  macSystem,
  macType,
  type DragEnd,
  type MacActionResult,
} from "../../lib/ipc";
import type { ToolDefinition } from "./tools";

/** Tools that let any AI in E.V use the Mac the way a person would. */

export const MAC_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "mac_open",
    description:
      "Open an app, a website or a file/folder. Use `app` to choose the app (e.g. target 'https://music.youtube.com', app 'Brave Browser'). A URL opens in a new tab of that browser in one step — for \"open X in a new tab\" or a search, open the search address directly (e.g. https://music.youtube.com/search?q=artist+name); never ⌘T, type the address and press Return. Unless they asked for a new tab, check mac_tabs first — don't open a site that's already open. Set show=false when it's only for your own work (it opens hidden, so the user isn't interrupted); leave it true when the user asked to see it.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "URL, file or folder path (optional when just opening an app)" },
        app: { type: "string", description: "App name, e.g. 'Discord', 'Vivaldi', 'Finder'" },
        show: { type: "boolean", description: "Bring it to the front for the user (default true)" },
      },
    },
  },
  {
    name: "mac_look",
    description:
      "Read an app's window in the background (it stays where it is; the user's screen isn't touched; a hidden app is started if needed): a numbered list of its controls (buttons, fields, rows, links, text). No picture unless you ask — the list is usually enough. The list includes controls further down or off to the side, marked off screen — click them directly. When you know what you're after (a button, a song, a field), pass find to get just those controls (capitals and plurals don't matter). Click/type/key results already show what changed, so don't look again just to check one.",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "App to look at, e.g. 'Discord'" },
        find: { type: "string", description: "Only list controls whose label has one of these words, e.g. 'repeat' or 'shuffle repeat' — far shorter. Leave out to see everything (first look at an unfamiliar window)." },
        picture: { type: "boolean", description: "Also take a picture — only when the look matters (photos, charts, layout) or the list isn't enough" },
        use_screen: { type: "boolean", description: "Only if the background look had no picture and you truly need to see it (photos, charts, layout)" },
      },
      required: ["app"],
    },
  },
  {
    name: "mac_click",
    description:
      "Click a control by its #id from the last look, or by its exact label — done in the background (the user's mouse and front app never move), including x,y clicks. The result says what changed in the window (new controls with their current numbers) or that nothing changed — if nothing changed, it didn't work: try another way, don't say it's done. Send/Submit/Delete-type buttons pause for the user's approval automatically; money buttons are refused. Set use_screen only if a background click had no visible effect.",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "The app the control belongs to" },
        id: { type: "integer", description: "Control number from mac_look" },
        label: { type: "string", description: "Instead of id: the control's label as mac_look showed it (read fresh, so it works without a look first)" },
        role: { type: "string", description: "With label: the control's role, e.g. Button, to pick the right one" },
        x: { type: "number", description: "Screen x (if no id)" },
        y: { type: "number", description: "Screen y (if no id)" },
        double: { type: "boolean", description: "Double-click" },
        right: { type: "boolean", description: "Right-click" },
        use_screen: { type: "boolean", description: "Allow a real click (borrows the screen briefly when the user pauses)" },
      },
      required: ["app"],
    },
  },
  {
    name: "mac_drag",
    description:
      "Drag in an app, in the background (the user's mouse doesn't move): a slider, a file, an item in a list, a shape. Each end is a control #id from the last look, a control label, or an x,y screen point. The result says what changed.",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "The app" },
        from_id: { type: "integer", description: "Start: control number" },
        from_label: { type: "string", description: "Start: control label" },
        from_x: { type: "number", description: "Start: screen x" },
        from_y: { type: "number", description: "Start: screen y" },
        to_id: { type: "integer", description: "End: control number" },
        to_label: { type: "string", description: "End: control label" },
        to_x: { type: "number", description: "End: screen x" },
        to_y: { type: "number", description: "End: screen y" },
        use_screen: { type: "boolean", description: "Only if a background drag had no effect" },
      },
      required: ["app"],
    },
  },
  {
    name: "mac_tabs",
    description:
      "The user's own browser tabs (Brave, Chrome, Vivaldi, Arc, Edge, Safari). action 'list' shows every open tab (window, tab, title, address; * = the tab showing). action 'switch' makes one the showing tab — by window and tab number, or by 'matching' text from its title or address (e.g. 'music.youtube.com') — in the background unless show=true. Use a tab that's already open instead of opening the site again: 'switch' with 'matching' straight away; list only if that fails. To get to a tab use this (or click the tab in the tab strip) — never keyboard shortcuts: ⌘⇧T reopens a closed tab, ⌘T opens a new one. Never opens or closes tabs.",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "The browser app, e.g. 'Brave Browser'" },
        action: { type: "string", enum: ["list", "switch"], description: "list or switch" },
        window: { type: "integer", description: "switch: window number from the list" },
        tab: { type: "integer", description: "switch: tab number from the list" },
        matching: { type: "string", description: "switch: text from the tab's title or address, instead of numbers" },
        show: { type: "boolean", description: "switch: also bring the browser to the front (only when the user asked to see it)" },
      },
      required: ["app", "action"],
    },
  },
  {
    name: "mac_menu",
    description:
      "Use an app's menu bar by name, in the background: path 'File > Export > PDF' runs that item. A path that ends at a menu ('File', or '' for the whole bar) lists its items with their keyboard shortcuts, so you can find the right one. Often the fastest, most reliable way to do something in an app. Risky items (Delete, Sign Out…) pause for approval.",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "The app, e.g. 'Preview'" },
        path: { type: "string", description: "Menu path with > between levels, e.g. 'File > Export as PDF…' (case and … don't matter)" },
      },
      required: ["app", "path"],
    },
  },
  {
    name: "mac_do",
    description:
      "Do several steps in one app in one go (in the background), then read its window again. Plan the sequence from the last look, e.g. Discord: [{do:'key', key:'k', modifiers:['command']}, {do:'type', text:'Chris'}, {do:'key', key:'return'}]. Steps: click {id} · type {text} (into the focused field) · key {key, modifiers} · wait {ms}. Stops at the first step that fails. Sends and deletes still pause for the user's approval.",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "The app" },
        steps: {
          type: "array",
          description: "Steps in order",
          items: {
            type: "object",
            properties: {
              do: { type: "string", enum: ["click", "type", "key", "wait"], description: "What to do" },
              id: { type: "integer", description: "Control number from the last look" },
              text: { type: "string", description: "Text to type" },
              key: { type: "string", description: "Key name" },
              modifiers: { type: "array", items: { type: "string" }, description: "command, shift, option, control" },
              ms: { type: "integer", description: "Milliseconds to wait (max 5000)" },
            },
            required: ["do"],
          },
        },
      },
      required: ["app", "steps"],
    },
  },
  {
    name: "mac_front",
    description:
      "What the user is looking at right now: the app in front, its window title and any text they've highlighted. Use it when they say 'this', 'that' or 'here' and didn't attach anything.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "mac_type",
    description:
      "Type into the focused field of an app (click the field first) — in the background whenever possible. New lines become Shift+Return, so typing never sends. Password fields are refused.",
    parameters: {
      type: "object",
      properties: { app: { type: "string", description: "The app to type into" }, text: { type: "string", description: "Text to type" } },
      required: ["app", "text"],
    },
  },
  {
    name: "mac_key",
    description:
      "Press a key in an app, e.g. key 'k' with ['command'] (Discord quick switcher), 'escape', 'tab', 'down' — sent to that app in the background. Return in a message box counts as sending and is paused for approval. Only press shortcuts you know the app has; never guess one to find something (that's what mac_look and mac_tabs are for). If a background key press had no effect (look again to check), retry with use_screen.",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "The app to press it in" },
        use_screen: { type: "boolean", description: "Allow a real key press (borrows the screen briefly when the user pauses)" },
        key: { type: "string", description: "Key name: a–z, 0–9, return, tab, space, escape, delete, up, down, left, right, pageup, pagedown, home, end" },
        modifiers: { type: "array", description: "Any of command, shift, option, control", items: { type: "string" } },
      },
      required: ["app", "key"],
    },
  },
  {
    name: "mac_scroll",
    description: "Scroll in an app's window, in the background (the user's mouse and screen don't move). Positive dy scrolls down (lines; 10–15 is about a screen). Looks already list off-screen controls, and clicking one scrolls to it, so scroll only for pages that load more as you go (feeds, long grids).",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "The app" },
        x: { type: "number", description: "Screen x" },
        y: { type: "number", description: "Screen y" },
        dy: { type: "integer", description: "Lines down (negative = up)" },
        dx: { type: "integer", description: "Lines right (negative = left)" },
      },
    },
  },
  {
    name: "find_my_file",
    description:
      "Find the user's own files with Spotlight in one step, ranked (name match, recently used, their folders first). Words narrow it: 'latest', 'pdf', 'in Downloads', 'from last week'. Use this before browsing folders; open = true opens the best match when it's clear.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What they asked for, e.g. 'my latest resume pdf'" },
        open: { type: "boolean", description: "Open it if one result is clearly the one" },
      },
      required: ["query"],
    },
  },
  {
    name: "mac_media",
    description: "Media keys for whatever is playing (Music, Spotify, YouTube Music in a browser…).",
    parameters: { type: "object", properties: { action: { type: "string", description: "Media key", enum: ["playpause", "next", "previous"] } }, required: ["action"] },
  },
  {
    name: "mac_system",
    description: "Set the volume (0–100), mute or unmute, or turn dark mode on/off. E.V remembers the old setting so it can be undone.",
    parameters: {
      type: "object",
      properties: {
        volume: { type: "integer", description: "0–100" },
        muted: { type: "boolean", description: "Mute" },
        dark_mode: { type: "boolean", description: "Dark mode" },
      },
    },
  },
  {
    name: "mac_screen",
    description: "Look at the whole screen (all apps). Needs the user's approval unless the plan allows it.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "mac_applescript",
    description:
      "Run AppleScript (or JavaScript for Automation) to control a scriptable app: Finder, Music, Spotify, Safari/Chrome/Vivaldi tabs, Mail drafts, Notes, Reminders, Calendar, System Events. Faster and more reliable than clicking when the app supports it. Shown to the user before it runs.",
    parameters: {
      type: "object",
      properties: {
        script: { type: "string", description: "The script" },
        javascript: { type: "boolean", description: "true for JavaScript for Automation" },
        purpose: { type: "string", description: "One plain sentence saying what it does, for the approval card" },
      },
      required: ["script", "purpose"],
    },
  },
  {
    name: "mac_shortcut",
    description: "Run one of the user's Apple Shortcuts by name.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Shortcut name" }, input: { type: "string", description: "Optional text input" } },
      required: ["name"],
    },
  },
  {
    name: "mac_quit",
    description: "Quit an app.",
    parameters: { type: "object", properties: { app: { type: "string", description: "App name" } }, required: ["app"] },
  },
  {
    name: "mac_clipboard",
    description: "Read the clipboard (omit `write`), or copy `write` to it.",
    parameters: { type: "object", properties: { write: { type: "string", description: "Text to copy" } } },
  },
];

export const MAC_TOOLS = new Set(MAC_TOOL_DEFINITIONS.map((t) => t.name));

/** A final action waiting on the user: a picture of what is about to happen and a description. */
export interface FinalRequest {
  kind: "send" | "delete";
  title: string;
  app: string;
}

export interface MacEnv {
  /** Shows the preview card and waits for the user's approval (passphrase in Talk mode). */
  confirmFinal: (request: FinalRequest) => Promise<boolean>;
  /** Called with every app the task opened or looked at. */
  noteApp: (app: string) => void;
  /** Waits until the user pauses (or agrees) before a step that needs the real screen. */
  waitForScreen: (what: string) => Promise<boolean>;
  /** Remembers the settings from before a change, so "Undo" can put them back. */
  noteUndo: (before: { volume?: number | null; muted?: boolean | null; darkMode?: boolean | null }) => void;
}

/** A finished action in a form that can run again later without the AI: by label, never by number. */
export interface ReplayStep {
  tool: string;
  args: Record<string, unknown>;
}

export interface MacOutcome {
  output: string;
  display: string;
  ok: boolean;
  /** JPEG (base64) the model sees with the result. */
  image?: string;
  /** The window showed the action worked (true), showed nothing changed (false), or couldn't tell. */
  confirmed?: boolean;
  /** How to repeat this action without the AI; null when it can't be repeated safely; absent for reads. */
  replay?: ReplayStep[] | null;
}

/** Simulated typing and clicking through System Events can't be inspected, so it isn't allowed. */
export function isGuiScripting(script: string): boolean {
  return /system events/i.test(script) && /\b(keystroke|key code|key down|click|perform action)\b/i.test(script);
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v));
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const DELETE_WORDS = /\b(delete|remove|trash|erase|discard|uninstall|empty)\b/i;

const PERMISSION_TEXT: Record<string, string> = {
  accessibility: "Accessibility (lets E.V read app windows, click and type)",
  screen: "Screen Recording (lets E.V see app windows)",
};

/** Turns backend refusals into plain instructions for the model. */
function explain(err: unknown): MacOutcome {
  const message = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
  const permission = /^PERMISSION:(\w+)/.exec(message)?.[1];
  if (permission) {
    return {
      output: `macOS hasn't given E.V ${PERMISSION_TEXT[permission] ?? permission} permission yet. Tell the user to click "Grant access" under this step (or System Settings → Privacy & Security → ${permission === "screen" ? "Screen Recording" : "Accessibility"} → turn on E.V), then ask again.`,
      display: `PERMISSION:${permission}`,
      ok: false,
    };
  }
  if (message.startsWith("NEVER:devtools")) {
    return {
      output: "Refused: E.V never opens developer tools, the console or page source in the user's browser, and never runs code in their pages. Read the page with mac_look (its controls and text) instead.",
      display: "Refused — no developer tools in your browser",
      ok: false,
    };
  }
  if (message.startsWith("NEVER:money")) {
    return { output: "Refused: E.V never does anything involving money. Tell the user they need to do this part themselves.", display: "Refused — money is never handled by E.V", ok: false };
  }
  return { output: `Error: ${message}`, display: message, ok: false };
}

function notNow(what: string): MacOutcome {
  return {
    output: `Not done yet: ${what} needs the screen for a moment and the user is busy or said not now. Tell them it's ready to finish whenever they want, and stop here.`,
    display: "Waiting for you — the screen is yours",
    ok: false,
  };
}

/** What the window showed afterwards, for the model. */
function afterward(result: MacActionResult): string {
  return result.report ? `\n${result.report}` : "";
}

function confirmedBy(result: MacActionResult): boolean | undefined {
  return result.changed === true ? true : result.changed === false ? false : undefined;
}

async function act(
  result: MacActionResult,
  what: string,
  request: FinalRequest,
  env: MacEnv,
  retry: (approved: boolean) => Promise<MacActionResult>,
  replay: ReplayStep | null,
): Promise<MacOutcome> {
  if (result.verdict === "never") {
    return {
      output: `Refused: "${result.target}" involves money or a password, which E.V never touches. Tell the user to do this step themselves.`,
      display: `Refused — ${result.target}`,
      ok: false,
    };
  }
  if (result.verdict === "final" && !result.done) {
    const approved = await env.confirmFinal(request);
    if (!approved) return { output: `The user did not approve "${what}". Nothing was sent or deleted. Don't retry it; ask what they'd like instead.`, display: "Not approved", ok: false };
    const again = await retry(true);
    // Approved actions (sends, deletes) are never repeated without the user.
    return again.done
      ? { output: `Done (approved by the user): ${what}.${afterward(again)}`, display: `${what} — approved`, ok: true, confirmed: confirmedBy(again), replay: null }
      : { output: `Couldn't complete ${what}.`, display: "Couldn't complete", ok: false, replay: null };
  }
  const where = result.mode.startsWith("background") ? " in the background" : result.mode === "screen" ? " (borrowed the screen for a moment)" : "";
  const confirmed = confirmedBy(result);
  if (confirmed === false) {
    return {
      output: `${what} (${result.target || "no label"}) went through${where}, but nothing changed.${afterward(result)}\nDon't report it as done.`,
      display: `${result.target || what} — nothing changed`,
      ok: true,
      confirmed,
      replay: null,
    };
  }
  const check = result.report ? afterward(result) : " Look again to check it worked.";
  return { output: `Done${where}: ${what} (${result.target || "no label"}).${check}`, display: result.target || what, ok: true, confirmed, replay: replay ? [replay] : null };
}

/** A text row that only repeats the control just before it (a link's or heading's own words) is dropped. */
function compactControls<T extends { role: string; label: string }>(controls: T[]): T[] {
  const out: T[] = [];
  for (const c of controls) {
    const prev = out.at(-1);
    if (c.role === "StaticText" && c.label && prev?.label && prev.label.includes(c.label)) continue;
    out.push(c);
  }
  return out;
}

/** "Quotes" → "quote", "Photos!" → "photo": the forgiving form used for find. */
function stem(word: string): string {
  const w = word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
}

function stemText(text: string): string {
  return ` ${text.split(/[^\p{L}\p{N}]+/u).map(stem).filter(Boolean).join(" ")} `;
}

/** Links keep their site and path; long tracking queries are cut. */
function shortUrl(url: string): string {
  const cut = url.replace(/^https?:\/\//, "");
  return cut.length > 70 ? `${cut.slice(0, 69)}…` : cut;
}

export async function executeMacTool(name: string, args: Record<string, unknown>, env: MacEnv): Promise<MacOutcome> {
  try {
    switch (name) {
      case "mac_open": {
        const app = str(args.app);
        if (app) env.noteApp(app);
        const hidden = args.show === false;
        const text = await macOpen(str(args.target) || undefined, app || undefined, hidden);
        return {
          output: `${text}${hidden ? " (in the background)" : ""}. Use mac_look to see it.`,
          display: text,
          ok: true,
          confirmed: true,
          replay: [{ tool: "mac_open", args: { target: args.target, app: args.app, show: args.show } }],
        };
      }
      case "mac_look": {
        const app = str(args.app);
        const useScreen = args.use_screen === true;
        if (useScreen && !(await env.waitForScreen(`take a picture of ${app}`))) return notNow(`take a picture of ${app}`);
        const look = await macLook(app || undefined, useScreen, args.picture === true);
        env.noteApp(look.app);
        // Positions only matter for x,y clicks, which only happen with a picture: otherwise
        // controls are clicked by number, so the list leaves them out (it's most of a look's size).
        const withPlaces = Boolean(look.image) || useScreen || look.controls.length < 3;
        const find = str(args.find).toLowerCase();
        // Forgiving: capitals, plurals and emoji don't matter ("quote" finds "Quotes 💬").
        const words = find.split(/[\s,]+/).map(stem).filter((w) => w.length > 1);
        const kept = compactControls(look.controls).filter((c) => !words.length || words.some((w) => stemText(`${c.role} ${c.label} ${c.url ?? ""}`).includes(w)));
        const controls = kept
          .map((c) => `#${c.id} ${c.role}${c.label ? ` "${c.label.length > 90 ? `${c.label.slice(0, 89)}…` : c.label}"` : ""}${c.url ? ` → ${shortUrl(c.url)}` : ""}${c.focused ? " (focused)" : ""}${c.place ? ` (${c.place}, off screen — clicking scrolls to it)` : withPlaces ? ` @ ${c.x},${c.y} ${c.w}×${c.h}` : ""}`)
          .join("\n");
        const found = words.length ? `\n(Only controls matching "${find}": ${kept.length} of ${look.controls.length}. Look without find to see everything.)` : "";
        return {
          output: `${look.app} — window "${look.window}"${withPlaces ? ` at ${look.frame.join(",")}` : ""}${look.note ? `\n${look.note}` : ""}${found}\nControls:\n${controls || (words.length ? "(nothing matches — look again without find)" : "(none readable — use the picture and click by x,y)")}`,
          display: `${look.app}${look.window ? ` — ${look.window}` : ""} · ${words.length ? `${kept.length} matching “${find}”` : `${look.controls.length} controls`}`,
          ok: true,
          image: look.image || undefined,
        };
      }
      case "mac_click": {
        const app = str(args.app);
        const request = {
          app,
          id: num(args.id),
          label: str(args.label) || undefined,
          role: str(args.role) || undefined,
          x: num(args.x),
          y: num(args.y),
          double: args.double === true,
          right: args.right === true,
        };
        let useScreen = args.use_screen === true && (await env.waitForScreen(`click in ${app}`));
        let first = await macClick({ ...request, approved: false, useScreen });
        if (first.needsScreen && !useScreen) {
          // The background way didn't work: borrow the screen for this one step, when the user pauses.
          if (!(await env.waitForScreen(`click in ${app}`))) return notNow(`click in ${app}`);
          useScreen = true;
          first = await macClick({ ...request, approved: false, useScreen });
        }
        const [role, ...rest] = first.target.split(" · ");
        const label = rest.join(" · ") || "control";
        const final: FinalRequest = { kind: DELETE_WORDS.test(label) ? "delete" : "send", title: `Click “${label}” in ${app}`, app };
        // Repeatable by its label; a bare screen point isn't (layouts move).
        const byControl = request.id !== undefined || request.label !== undefined;
        const replay = byControl && rest.join("").trim() ? { tool: "mac_click", args: { app, label: rest.join(" · "), role, double: request.double, right: request.right } } : null;
        return act(first, `clicked ${label}`, final, env, (approved) => macClick({ ...request, approved, useScreen }), replay);
      }
      case "mac_drag": {
        const app = str(args.app);
        const end = (side: "from" | "to"): DragEnd => ({ id: num(args[`${side}_id`]), label: str(args[`${side}_label`]) || undefined, x: num(args[`${side}_x`]), y: num(args[`${side}_y`]) });
        const [from, to] = [end("from"), end("to")];
        let useScreen = args.use_screen === true && (await env.waitForScreen(`drag in ${app}`));
        let result = await macDrag(app, from, to, args.right === true, useScreen);
        if (result.needsScreen && !useScreen) {
          if (!(await env.waitForScreen(`drag in ${app}`))) return notNow(`drag in ${app}`);
          useScreen = true;
          result = await macDrag(app, from, to, args.right === true, true);
        }
        const replay = from.label && to.label ? { tool: "mac_drag", args: { app, from_label: from.label, to_label: to.label } } : null;
        return act(result, `dragged ${result.target}`, { kind: "send", title: `Drag ${result.target} in ${app}`, app }, env, async () => result, replay);
      }
      case "mac_tabs": {
        const app = str(args.app);
        env.noteApp(app);
        const line = (t: { window: number; tab: number; active: boolean; title: string; url: string }) =>
          `${t.active ? "*" : " "} window ${t.window} tab ${t.tab}: ${t.title || "(untitled)"} — ${t.url}`;
        if (str(args.action) !== "switch") {
          const tabs = await macTabs(app, "list");
          return {
            output: tabs.length ? `${app} tabs (* = showing in its window):\n${tabs.map(line).join("\n")}` : `${app} has no open windows.`,
            display: `${tabs.length} tabs in ${app}`,
            ok: true,
          };
        }
        const matching = str(args.matching) || undefined;
        const now = await macTabs(app, "switch", { window: num(args.window), tab: num(args.tab), matching }, args.show === true);
        const shown = now[0];
        // Repeatable by what the tab is (its site), not by its position, which changes.
        const site = matching ?? (shown ? (() => { try { return new URL(shown.url).host; } catch { return ""; } })() : "");
        return {
          output: `Switched to ${shown ? line(shown) : "that tab"} in ${app}${args.show === true ? " (brought to the front)" : " (in the background)"}. mac_look to read it.`,
          display: shown ? shown.title || shown.url : "Switched tab",
          ok: true,
          confirmed: Boolean(shown),
          replay: site ? [{ tool: "mac_tabs", args: { app, action: "switch", matching: site } }] : null,
        };
      }
      case "mac_menu": {
        const app = str(args.app);
        const path = str(args.path);
        env.noteApp(app);
        const out = await macMenu(app, path);
        if (!out.action) return { output: out.listing, display: path ? `${app} — ${path}` : `${app} menus`, ok: true };
        const final: FinalRequest = { kind: DELETE_WORDS.test(path) ? "delete" : "send", title: `Menu “${path}” in ${app}`, app };
        return act(out.action, `ran ${path}`, final, env, async (approved) => (await macMenu(app, path, approved)).action ?? out.action!, { tool: "mac_menu", args: { app, path } });
      }
      case "mac_type": {
        const app = str(args.app);
        let result = await macType(str(args.text), app);
        if (result.verdict === "never") return act(result, "typing", { kind: "send", title: "", app: "" }, env, async () => result, null);
        if (result.needsScreen) {
          if (!(await env.waitForScreen(`type in ${app}`))) return notNow(`type in ${app}`);
          result = await macType(str(args.text), app, true);
        }
        return {
          output: `Typed into ${result.target || "the focused field"} ${result.mode === "background" ? "in the background" : "(borrowed the screen for a moment)"}. Nothing was sent.${afterward(result)}`,
          display: `Typed ${str(args.text).length} characters`,
          ok: true,
          confirmed: confirmedBy(result),
          replay: [{ tool: "mac_type", args: { app, text: str(args.text) } }],
        };
      }
      case "mac_key": {
        const app = str(args.app);
        const key = str(args.key);
        const modifiers = Array.isArray(args.modifiers) ? args.modifiers.map(str) : [];
        const combo = [...modifiers, key].join("+");
        const useScreen = args.use_screen === true && (await env.waitForScreen(`press ${combo} in ${app}`));
        if (args.use_screen === true && !useScreen) return notNow(`press ${combo} in ${app}`);
        const first = await macKey(key, modifiers, false, app, useScreen);
        const final: FinalRequest = { kind: /delete|backspace/i.test(key) ? "delete" : "send", title: `Press ${combo} in “${first.target || app}”`, app };
        return act(first, `pressed ${combo}`, final, env, (approved) => macKey(key, modifiers, approved, app, useScreen), { tool: "mac_key", args: { app, key, modifiers } });
      }
      case "mac_scroll": {
        const app = str(args.app);
        const [x, y, dx, dy] = [num(args.x), num(args.y), Math.round(num(args.dx) ?? 0), Math.round(num(args.dy) ?? 0)];
        // In the background first (the user's mouse and screen never move); the screen only when
        // the window ignores that, and only once the user is idle.
        const mode = await macScroll(app, x, y, dx, dy, args.use_screen === true);
        if (mode === "background") return { output: "Scrolled in the background. Control numbers are current — look again (or with find) to see what's there now.", display: "Scrolled", ok: true, confirmed: true, replay: [{ tool: "mac_scroll", args: { app, dx, dy } }] };
        if (mode === "needs_screen") {
          if (!(await env.waitForScreen(`scroll in ${app}`))) return notNow(`scroll in ${app}`);
          await macScroll(app, x, y, dx, dy, true);
        }
        return { output: "Scrolled. Look again to see what's there now.", display: "Scrolled", ok: true, replay: null };
      }
      case "mac_do": {
        const app = str(args.app);
        const steps = Array.isArray(args.steps) ? (args.steps as Record<string, unknown>[]) : [];
        const done: string[] = [];
        let replay: ReplayStep[] | null = [];
        let confirmed: boolean | undefined = true;
        for (const [i, step] of steps.entries()) {
          const kind = str(step.do);
          if (kind === "wait") {
            const ms = Math.min(num(step.ms) ?? 500, 5000);
            await new Promise((r) => setTimeout(r, ms));
            replay?.push({ tool: "wait", args: { ms } });
            continue;
          }
          const tool = kind === "click" ? "mac_click" : kind === "type" ? "mac_type" : kind === "key" ? "mac_key" : "";
          if (!tool) return { output: `Step ${i + 1}: unknown step "${kind}". Done so far: ${done.join(" → ") || "nothing"}.`, display: `Stopped at step ${i + 1}`, ok: false };
          const out = await executeMacTool(tool, { ...step, app }, env);
          if (!out.ok) {
            return { output: `Done: ${done.join(" → ") || "nothing"}. Stopped at step ${i + 1} (${kind}): ${out.output}`, display: `${done.length}/${steps.length} steps · stopped`, ok: false };
          }
          done.push(out.display);
          replay = replay && out.replay ? [...replay, ...out.replay] : null;
          if (out.confirmed === false) confirmed = false;
          else if (out.confirmed === undefined && confirmed) confirmed = undefined;
          // Give the app a moment to react before the next step.
          await new Promise((r) => setTimeout(r, 120));
        }
        const look = await macLook(app || undefined).catch(() => null);
        const controls = look?.controls.map((c) => `#${c.id} ${c.role}${c.label ? ` "${c.label}"` : ""}${c.url ? ` → ${c.url}` : ""}${c.focused ? " (focused)" : ""}`).join("\n") ?? "";
        return {
          output: `Done: ${done.join(" → ")}.\nNow: ${look ? `${look.app} — window "${look.window}"\nControls:\n${controls}` : "(couldn't read the window)"}`,
          display: `${steps.length} steps in ${app}`,
          ok: true,
          confirmed,
          replay,
        };
      }
      case "mac_front": {
        const front = await macFront();
        return {
          output: `In front: ${front.app}${front.window ? ` — window "${front.window}"` : ""}${front.selected ? `\nHighlighted text:\n${front.selected}` : "\nNothing highlighted."}`,
          display: `${front.app}${front.window ? ` — ${front.window}` : ""}`,
          ok: true,
        };
      }
      case "find_my_file": {
        const found = await findMyFiles(str(args.query));
        if (found.empty || !found.results.length) return { output: `Spotlight found nothing for “${str(args.query)}”.`, display: "No match", ok: true };
        if (args.open === true && found.clear) {
          await fileOpen(found.results[0].path);
          return { output: `Opened ${found.results[0].path}.`, display: `Opened ${found.results[0].name}`, ok: true, confirmed: true };
        }
        const lines = found.results.map((r, i) => `${i + 1}. ${r.path}${r.when ? ` (${r.when})` : ""}${r.named ? "" : " [only mentions it]"}`);
        return { output: `${found.clear ? "Clear best match first." : "No single clear match; ask which one if it matters."}\n${lines.join("\n")}`, display: `${found.results.length} files`, ok: true };
      }
      case "mac_media":
        await macMedia(str(args.action));
        return { output: `Pressed ${str(args.action)}.`, display: str(args.action), ok: true, confirmed: true, replay: [{ tool: "mac_media", args: { action: args.action } }] };
      case "mac_system": {
        const change = {
          volume: num(args.volume),
          muted: typeof args.muted === "boolean" ? args.muted : undefined,
          darkMode: typeof args.dark_mode === "boolean" ? args.dark_mode : undefined,
        };
        const before = await macSystem(change);
        env.noteUndo({
          ...(change.volume !== undefined ? { volume: before.volume } : {}),
          ...(change.muted !== undefined ? { muted: before.muted } : {}),
          ...(change.darkMode !== undefined ? { darkMode: before.darkMode } : {}),
        });
        const parts = [change.volume !== undefined && `volume ${change.volume}`, change.muted !== undefined && (change.muted ? "muted" : "unmuted"), change.darkMode !== undefined && `dark mode ${change.darkMode ? "on" : "off"}`].filter(Boolean);
        return { output: `Set ${parts.join(", ")}.`, display: parts.join(", "), ok: true, confirmed: true, replay: [{ tool: "mac_system", args: { volume: args.volume, muted: args.muted, dark_mode: args.dark_mode } }] };
      }
      case "mac_screen": {
        const image = await macScreen();
        return { output: "Picture of the whole screen attached.", display: "Looked at the screen", ok: true, image, replay: null };
      }
      case "mac_applescript": {
        if (isGuiScripting(str(args.script))) {
          return {
            output:
              "Refused: scripted keystrokes and clicks (System Events keystroke / key code / click) bypass E.V's safety checks. Use mac_click and mac_key instead — they check what each click or key does.",
            display: "Refused — use mac_click / mac_key for clicks and keys",
            ok: false,
          };
        }
        const out = await macApplescript(str(args.script), args.javascript === true);
        return { output: out ? `Result: ${out}` : "Done.", display: out.slice(0, 300) || "Done", ok: true, replay: null };
      }
      case "mac_shortcut": {
        const out = await macShortcut(str(args.name), str(args.input) || undefined);
        return {
          output: out ? `Shortcut result: ${out}` : "Shortcut finished.",
          display: str(args.name),
          ok: true,
          confirmed: true,
          // A shortcut that hands back a result is answering a question; the AI has to read it.
          replay: out ? null : [{ tool: "mac_shortcut", args: { name: args.name, input: args.input } }],
        };
      }
      case "mac_quit":
        return { output: await macQuit(str(args.app)), display: `Quit ${str(args.app)}`, ok: true, confirmed: true, replay: [{ tool: "mac_quit", args: { app: args.app } }] };
      case "mac_clipboard": {
        if (typeof args.write === "string") return { output: await macClipboard(args.write), display: "Copied", ok: true, replay: null };
        const text = await macClipboard();
        return { output: text ? `Clipboard: ${text.slice(0, 20_000)}` : "The clipboard is empty.", display: `${text.length} characters`, ok: true, replay: null };
      }
      default:
        return { output: `Unknown Mac tool ${name}.`, display: "", ok: false };
    }
  } catch (err) {
    return explain(err);
  }
}

/** One plain line for an action on the Mac, for cards and receipts. */
export function describeMacTool(name: string, args: Record<string, unknown>): string {
  const app = str(args.app);
  switch (name) {
    case "mac_open":
      return str(args.target) ? `Open ${str(args.target)}${app ? ` in ${app}` : ""}` : `Open ${app}`;
    case "mac_look":
      return `Look at ${app || "the front app"}`;
    case "mac_do":
      return `${app}: ${(Array.isArray(args.steps) ? (args.steps as Record<string, unknown>[]) : [])
        .map((s) => (str(s.do) === "type" ? `type “${str(s.text).slice(0, 40)}”` : str(s.do) === "click" ? `click #${str(s.id)}` : str(s.do) === "key" ? `press ${[...(Array.isArray(s.modifiers) ? s.modifiers.map(str) : []), str(s.key)].join("+")}` : "wait"))
        .join(" → ")}`;
    case "mac_front":
      return "See what's in front of you";
    case "mac_click":
      return `Click ${args.id !== undefined ? `#${str(args.id)}` : str(args.label) ? `“${str(args.label)}”` : `${str(args.x)},${str(args.y)}`} in ${app}`;
    case "mac_drag": {
      const end = (side: string) => (args[`${side}_id`] !== undefined ? `#${str(args[`${side}_id`])}` : str(args[`${side}_label`]) ? `“${str(args[`${side}_label`])}”` : `${str(args[`${side}_x`])},${str(args[`${side}_y`])}`);
      return `Drag ${end("from")} to ${end("to")} in ${app}`;
    }
    case "mac_menu":
      return str(args.path) ? `${app} menu: ${str(args.path)}` : `List ${app}'s menus`;
    case "mac_tabs":
      return str(args.action) === "switch"
        ? `Switch to ${str(args.matching) ? `the “${str(args.matching)}” tab` : `tab ${str(args.tab)}`} in ${app}`
        : `List ${app} tabs`;
    case "mac_type":
      return `Type “${str(args.text).slice(0, 60)}${str(args.text).length > 60 ? "…" : ""}”`;
    case "mac_key":
      return `Press ${[...(Array.isArray(args.modifiers) ? args.modifiers.map(str) : []), str(args.key)].join("+")}`;
    case "mac_scroll":
      return "Scroll";
    case "find_my_file":
      return args.open === true ? `Find and open “${str(args.query)}”` : `Find “${str(args.query)}”`;
    case "mac_media":
      return { playpause: "Play / pause", next: "Next track", previous: "Previous track" }[str(args.action)] ?? "Media key";
    case "mac_system":
      return "Change volume / dark mode";
    case "mac_screen":
      return "Look at the whole screen";
    case "mac_applescript":
      return str(args.purpose) || "Run AppleScript";
    case "mac_shortcut":
      return `Run Shortcut “${str(args.name)}”`;
    case "mac_quit":
      return `Quit ${app}`;
    case "mac_clipboard":
      return typeof args.write === "string" ? "Copy to the clipboard" : "Read the clipboard";
    default:
      return name;
  }
}
