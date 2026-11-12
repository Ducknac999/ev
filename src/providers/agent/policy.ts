import { absolutePath, isDeleteCommand, isInside, isSafeCommand, reachesOutside } from "./tools";
import { connectionCategory, describeConnectionTool, isConnectionTool } from "./connections";
import { browserPersonal, browserUrls } from "./browserTools";

/**
 * Who decides what needs approval: a fixed category for every action, and a level per category
 * that the user sets on the Approvals page (money and passwords are locked to "never").
 *
 *   just  — happens without asking
 *   plan  — needs approval, unless it's inside a plan the user approved for this task
 *   final — can't be taken back: always its own approval, with a preview
 *   never — refused; the AI tells the user to do it themselves
 */
export type Level = "just" | "plan" | "final" | "never";

export type Category =
  | "internal"
  | "web"
  | "open"
  | "media"
  | "look_app"
  | "prepare"
  | "clipboard_write"
  | "read_project"
  | "browser"
  | "gideon_browser"
  | "browser_personal"
  | "connected_read"
  | "look_screen"
  | "clipboard_read"
  | "quit_app"
  | "scripts"
  | "edit_project"
  | "connected_change"
  | "outside_files"
  | "share_local"
  | "send"
  | "delete"
  | "install"
  | "money"
  | "passwords";

export interface CategoryInfo {
  label: string;
  detail: string;
  level: Level;
  locked?: boolean;
  /** Not shown on the Approvals page. */
  hidden?: boolean;
}

export const CATEGORIES: Record<Category, CategoryInfo> = {
  internal: { label: "Task list, skills, memory, math", detail: "E.V's own helpers", level: "just", locked: true, hidden: true },
  web: { label: "Search the web, weather, sports, Wikipedia", detail: "Reads public information", level: "just" },
  open: { label: "Open apps, websites and files", detail: "e.g. your browser → YouTube Music", level: "just" },
  media: { label: "Play / pause / skip, volume, dark mode", detail: "Undoable in a second", level: "just" },
  look_app: { label: "Look at an app's window", detail: "Read-only, in the background; pictures are never saved", level: "just" },
  prepare: { label: "Click and type to prepare", detail: "Drafts, searching, navigating — never sends or confirms", level: "just" },
  clipboard_write: { label: "Copy to the clipboard", detail: "", level: "just" },
  read_project: { label: "Read your project folder", detail: "Plus look-only commands like git status", level: "just" },
  browser: { label: "Use the extra headless browser (Connections)", detail: "Research and click through websites in the background — never your own browser's tabs", level: "just" },
  gideon_browser: {
    label: "Use the E.V Browser",
    detail: "Its own hidden browser with its own Google account — browse, click, type, sign in, post. Never your own browser; money and passwords stay blocked",
    level: "just",
  },
  browser_personal: { label: "Type your personal details into a website", detail: "Emails, phone numbers, addresses — or anything after reading your files", level: "plan" },
  connected_read: { label: "Read from connected services", detail: "Gmail, Calendar, Notes, Reminders, YouTube… (Settings → Connections)", level: "just" },
  look_screen: { label: "Look at the whole screen", detail: "Could show something private from other apps", level: "plan" },
  clipboard_read: { label: "Read the clipboard", detail: "Could hold something private", level: "plan" },
  quit_app: { label: "Quit apps", detail: "Unsaved work could be lost", level: "plan" },
  scripts: { label: "Run scripts, Shortcuts and Terminal commands", detail: "Includes changing Mac settings", level: "plan" },
  edit_project: { label: "Create and edit files in your project", detail: "Done in a safe copy you review", level: "plan" },
  connected_change: { label: "Change things in connected services", detail: "Drafts, notes, reminders, events — sending and deleting always preview", level: "plan" },
  outside_files: { label: "Files outside your project folder", detail: "Read or change", level: "plan" },
  share_local: { label: "Open a web page after reading your files", detail: "Could carry your data out", level: "plan" },
  send: { label: "Send, post, reply, submit", detail: "Messages, email, social, forms — with a preview", level: "final" },
  delete: { label: "Delete or move to Trash", detail: "With a preview", level: "final" },
  install: { label: "Install or uninstall apps", detail: "", level: "final" },
  money: { label: "Money: paying, buying, banking, crypto", detail: "E.V never does this", level: "never", locked: true },
  passwords: { label: "Typing passwords or security codes", detail: "E.V never does this", level: "never", locked: true },
};

export const DEFAULT_LEVELS = Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.level])) as Record<Category, Level>;

/** Apps E.V never touches until the user removes them from the list. */
export const DEFAULT_NEVER_APPS = ["1Password", "Bitwarden", "LastPass", "Dashlane", "Keychain Access", "Passwords", "Wallet"];

export interface Rules {
  levels: Record<Category, Level>;
  neverApps: string[];
}

export const DEFAULT_RULES: Rules = { levels: { ...DEFAULT_LEVELS }, neverApps: [...DEFAULT_NEVER_APPS] };

export function normalizeRules(raw: Partial<Rules> | undefined): Rules {
  const levels = { ...DEFAULT_LEVELS };
  for (const [key, info] of Object.entries(CATEGORIES) as [Category, CategoryInfo][]) {
    const wanted = raw?.levels?.[key];
    if (!info.locked && (wanted === "just" || wanted === "plan" || wanted === "final" || wanted === "never")) levels[key] = wanted;
  }
  const neverApps = Array.isArray(raw?.neverApps) ? raw!.neverApps.filter((a): a is string => typeof a === "string" && a.trim() !== "") : [...DEFAULT_NEVER_APPS];
  return { levels, neverApps };
}

/** An approved plan: what this task may do without asking again. */
export interface PlanScope {
  title: string;
  /** Files or folders (relative to the project, or absolute); "src/" covers everything inside. */
  files: string[];
  commands: string[];
  apps: string[];
  /** Also allowed: "screen", "clipboard". */
  access: string[];
}

export interface PolicyContext {
  cwd: string;
  home: string;
  hasProject: boolean;
  readLocal: boolean;
  /** Apps this task opened, or the user named, so looking at them needs no approval. */
  taskApps: Set<string>;
  neverApps: string[];
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v));
const same = (a: string, b: string) => a.trim().toLowerCase().replace(/\.app$/, "") === b.trim().toLowerCase().replace(/\.app$/, "");

const INTERNAL = new Set([
  "split_into_helpers", "load_tools", "document_part", "command_output", "command_stop", "ask_user", "agent",
  "todo_write", "load_skill", "calculate", "convert_units", "convert_time", "propose_plan", "plan_progress",
  "remember", "forget", "suggest_memory", "schedule_add", "schedule_update", "schedule_delete", "schedule_list",
]);

const INSTALL = /\b(brew\s+(install|uninstall|reinstall|remove)|mas\s+(install|uninstall)|installer\s+-pkg|npm\s+(i|install|uninstall)\s+(-g|--global)|pip3?\s+install\s+--user|softwareupdate\s+-i)\b/;
const SCRIPT_SENDS = /\b(send|reply|post|publish|submit)\b/i;

/** Words that make an AppleScript change something; a script with none of them only reads. */
const SCRIPT_CHANGES =
  /\b(set|make|delete|move|duplicate|close|quit|open|activate|launch|run|play|pause|playpause|stop|next|previous|back track|click|keystroke|key code|do shell script|do javascript|execute|save|send|empty|reveal|select|reload|print|create|remove|erase|eject|restart|shut down|log out|sleep|mount|import|export|add|update|write|copy|paste|display|say|beep)\b/i;

/** An AppleScript that only reads (song name, open tabs, window titles) — treated like looking. */
export function isReadOnlyScript(script: string, javascript = false): boolean {
  return !javascript && script.trim().length > 0 && !SCRIPT_CHANGES.test(script);
}
/** `tell application "Discord" to activate` (or launch / reopen), and nothing else. */
const OPEN_ONLY_SCRIPT = /^\s*tell application "[^"]+" to (activate|launch|reopen)\s*$/i;
const SCRIPT_DELETES = /\b(delete|trash|erase|remove|empty)\b/i;

/** The app a Mac action is aimed at, if any. */
export function appOf(name: string, args: Record<string, unknown>): string {
  if (["mac_open", "mac_look", "mac_click", "mac_drag", "mac_menu", "mac_tabs", "mac_quit", "page_look", "page_do"].includes(name)) return str(args.app);
  if (name === "mac_applescript") return /tell application "([^"]+)"/i.exec(str(args.script))?.[1] ?? "";
  return "";
}

export function categoryFor(name: string, args: Record<string, unknown>, ctx: PolicyContext): Category {
  if (INTERNAL.has(name)) return "internal";
  if (name === "make_graph") return args.open_desmos === true ? "gideon_browser" : "internal";
  if (name.startsWith("browser_")) {
    // Its own browser and account: free — except carrying the user's own details out.
    if (browserPersonal(name, args, ctx.readLocal)) return "browser_personal";
    if (ctx.readLocal && browserUrls(name, args).some(Boolean)) return "share_local";
    return "gideon_browser";
  }
  if (isConnectionTool(name)) return connectionCategory(name, args);
  const app = appOf(name, args);
  if (app && ctx.neverApps.some((a) => same(a, app))) return "money";
  switch (name) {
    case "web_search":
    case "get_weather":
    case "sports":
    case "wikipedia":
      return "web";
    case "web_fetch":
    case "video_facts":
    case "video_frames":
      return ctx.readLocal ? "share_local" : "web";
    case "read_file":
    case "list_directory":
    case "find_files":
    case "search_files":
      return !ctx.hasProject || reachesOutside(name, args, ctx.cwd, ctx.home) ? "outside_files" : "read_project";
    case "condense_document":
      // Reads its source like read_file; the result is only a draft until make_document saves it.
      return !ctx.hasProject || reachesOutside("read_file", { path: args.source }, ctx.cwd, ctx.home) ? "outside_files" : "read_project";
    case "write_file":
    case "edit_file":
    case "make_document":
      return !ctx.hasProject || reachesOutside(name, args, ctx.cwd, ctx.home) ? "outside_files" : "edit_project";
    case "run_command": {
      const command = str(args.command);
      if (isDeleteCommand(command)) return "delete";
      if (INSTALL.test(command)) return "install";
      if (ctx.hasProject && isSafeCommand(command)) return "read_project";
      return "scripts";
    }
    case "mac_open":
      return "open";
    case "mac_media":
    case "mac_system":
      return "media";
    case "find_my_file":
      // Finding (and opening) your own file with Spotlight: like double-clicking it in Finder.
      return args.open === true ? "open" : "look_app";
    case "mac_look":
    case "page_look":
      // Reading one app's window (or a page in it) changes nothing: never asks (never-touch apps are caught above).
      return "look_app";
    case "page_do":
      // Like clicking: sends, deletes, money and passwords are judged per action right before it runs.
      return "prepare";
    case "mac_screen":
      return "look_screen";
    case "mac_front":
      return "look_app";
    case "mac_tabs":
      // Listing reads tab titles; switching only changes which open tab shows (nothing is opened or sent).
      return args.action === "switch" ? "prepare" : "look_app";
    case "mac_click":
    case "mac_drag":
    case "mac_menu":
    case "mac_type":
    case "mac_key":
    case "mac_do":
    case "mac_scroll":
      // Sends, deletes and money are caught when the control is inspected, right before acting.
      return "prepare";
    case "mac_applescript": {
      const script = str(args.script);
      if (isReadOnlyScript(script, args.javascript === true)) return "look_app";
      // Only bringing an app up is the same as opening it.
      if (args.javascript !== true && OPEN_ONLY_SCRIPT.test(script)) return "open";
      if (SCRIPT_SENDS.test(script)) return "send";
      if (SCRIPT_DELETES.test(script)) return "delete";
      return "scripts";
    }
    case "mac_shortcut":
      return "scripts";
    case "mac_quit":
      return "quit_app";
    case "mac_clipboard":
      return args.write === undefined || args.write === null ? "clipboard_read" : "clipboard_write";
    default:
      return "scripts";
  }
}

function matchesFile(target: string, entry: string, cwd: string, home: string): boolean {
  const want = absolutePath(entry.replace(/\*+$/, ""), cwd, home);
  return entry.endsWith("/") || entry.endsWith("*") ? isInside(target, want.replace(/\/$/, "")) : target === want || isInside(target, want);
}

/** Whether an approved plan already allows this action. */
export function planCovers(plan: PlanScope | null, category: Category, name: string, args: Record<string, unknown>, ctx: PolicyContext): boolean {
  if (!plan) return false;
  switch (category) {
    case "edit_project":
    case "outside_files": {
      const path = str(args.path) || ".";
      const target = absolutePath(path, ctx.cwd, ctx.home);
      return plan.files.some((f) => matchesFile(target, f, ctx.cwd, ctx.home));
    }
    case "scripts": {
      if (name === "run_command") {
        const command = str(args.command);
        return plan.commands.some((c) => command === c.trim() || command.startsWith(`${c.trim()} `));
      }
      const app = appOf(name, args);
      if (name === "mac_shortcut") return plan.apps.some((a) => same(a, "Shortcuts") || same(a, str(args.name)));
      return Boolean(app) && plan.apps.some((a) => same(a, app));
    }
    case "quit_app":
      return plan.apps.some((a) => same(a, appOf(name, args)));
    case "look_screen":
      return plan.access.includes("screen") || (Boolean(appOf(name, args)) && plan.apps.some((a) => same(a, appOf(name, args))));
    case "clipboard_read":
      return plan.access.includes("clipboard");
    case "share_local":
      return false;
    default:
      return false;
  }
}

/** What happens next for an action: run it, ask (with or without a plan), or refuse. */
export function decide(
  category: Category,
  levels: Record<Category, Level>,
  plan: PlanScope | null,
  name: string,
  args: Record<string, unknown>,
  ctx: PolicyContext,
): "run" | "approve" | "final" | "never" {
  const level = levels[category] ?? "plan";
  if (level === "never") return "never";
  if (level === "just") return "run";
  if (level === "final") return "final";
  return planCovers(plan, category, name, args, ctx) ? "run" : "approve";
}

/**
 * Text with the parts that change on their own taken out — counts, numbers, times, anything in
 * brackets — so a rule made from it still matches tomorrow. "(3) Inbox — Mail" → "inbox — mail".
 */
export function steadyText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, " ")
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b/g, " ")
    .replace(/\d+/g, " ")
    .replace(/[•·|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What an "Approve always" for this action covers, as a stable key plus a plain description —
 * or null when the action can't be always-approved (plans: each is for one job).
 *
 *   scripts    → that app ("Scripts that control Spotify")
 *   commands   → that exact command in that folder
 *   files      → files in that folder
 *   sends      → that app and conversation (e.g. Discord @Chris)
 *   deletes    → that exact action
 */
export function alwaysScope(
  name: string,
  args: Record<string, unknown>,
  category: Category,
  ctx: Pick<PolicyContext, "cwd" | "home">,
  final?: { app: string; where: string; what: string },
): { key: string; label: string } | null {
  if (name === "propose_plan" || category === "money" || category === "passwords" || category === "internal" || category === "browser_personal") return null;
  const folderOf = (p: string) => {
    const abs = absolutePath(p || ".", ctx.cwd, ctx.home);
    return abs.slice(0, abs.lastIndexOf("/")) || "/";
  };
  if (final) {
    const verb = category === "delete" ? "Delete" : "Send";
    // `where` is already the stable place (see placeOf): a website, a person or channel, a folder.
    const place = final.where === "*" ? "" : final.where;
    return {
      key: `final2:${category}:${final.app.toLowerCase()}:${final.where.toLowerCase()}:${category === "delete" ? steadyText(final.what) : ""}`,
      label: `${verb} in ${final.app}${place ? ` — ${place}` : ""}${category === "delete" ? ` (${final.what})` : ""}`,
    };
  }
  if (isConnectionTool(name)) return { key: `connection:${category}:${name}`, label: describeConnectionTool(name, {}) };
  switch (name) {
    case "run_command": {
      const command = str(args.command);
      return { key: `command:${ctx.cwd}:${command}`, label: `Run \`${command}\` in ${ctx.cwd.replace(ctx.home, "~")}` };
    }
    case "write_file":
    case "edit_file":
    case "make_document":
    case "read_file":
    case "list_directory":
    case "find_files":
    case "search_files": {
      const folder = name === "list_directory" || name === "find_files" || name === "search_files" ? absolutePath(str(args.path) || ".", ctx.cwd, ctx.home) : folderOf(str(args.path));
      const verb = name === "write_file" || name === "edit_file" || name === "make_document" ? "Create and edit files" : "Read files";
      return { key: `files:${verb}:${folder}`, label: `${verb} in ${folder.replace(ctx.home, "~")}` };
    }
    case "mac_applescript": {
      const app = appOf(name, args) || "the Mac";
      const kind = category === "send" ? "Send with" : category === "delete" ? "Delete with" : "Scripts that control";
      return { key: `script:${category}:${app.toLowerCase()}`, label: `${kind} ${app}` };
    }
    case "mac_shortcut":
      return { key: `shortcut:${str(args.name).toLowerCase()}`, label: `Run the Shortcut “${str(args.name)}”` };
    case "mac_quit":
      return { key: `quit:${str(args.app).toLowerCase()}`, label: `Quit ${str(args.app)}` };
    case "mac_screen":
      return { key: "screen", label: "Look at the whole screen" };
    case "mac_clipboard":
      return { key: "clipboard:read", label: "Read the clipboard" };
    case "mac_look":
      return { key: `look:${str(args.app).toLowerCase()}`, label: `Look at ${str(args.app)}` };
    case "web_fetch": {
      let host = str(args.url);
      try {
        host = new URL(host).hostname;
      } catch {
        /* keep as typed */
      }
      return { key: `web:${host}`, label: `Open pages on ${host}` };
    }
    default:
      return { key: `${category}:${name}:${appOf(name, args).toLowerCase()}`, label: `${name.replace(/^mac_/, "")}${appOf(name, args) ? ` in ${appOf(name, args)}` : ""}` };
  }
}
