import {
  liveFetchJson,
  loadSkill,
  toolCancel,
  toolReadDocument,
  toolEditFile,
  toolFindFiles,
  toolListDirectory,
  toolReadFile,
  toolRunCommand,
  toolSearchFiles,
  toolWebFetch,
  toolWebSearch,
  toolWriteFile,
} from "../../lib/ipc";
import { uid } from "../../lib/ids";
import { describeMacTool, executeMacTool, MAC_TOOL_DEFINITIONS, MAC_TOOLS, type MacEnv, type ReplayStep } from "./macTools";
import { executeMemoryTool, MEMORY_TOOL_DEFINITIONS, MEMORY_TOOLS } from "./memoryTools";
import { describeConnectionTool, executeConnectionTool, isConnectionTool } from "./connections";
import { BROWSER_TOOL_DEFINITIONS, describeBrowserTool, executeBrowserTool } from "./browserTools";
import type { GraphResult } from "./graph";
import { calculate, convertTime, convertUnits, formatNumber, sports, SPORTS_LEAGUES, weather, wikipedia, type FetchJson } from "./liveTools";
import type { ToolPreview, UndoInfo } from "../../types";
import { lineDiff } from "./diff";
import { backgroundOutput, isDocumentPath, pageBlocks, makeDocument, readDocument, REPLACED_SKILL_NOTE, REPLACED_SKILLS, htmlWords, startBackground, stopBackground, unreadPages, WORK_TOOL_DEFINITIONS, type PagesRead } from "./workTools";

/** JSON-schema subset understood by both Gemini function declarations and OpenAI tools. */
export interface ToolSchema {
  type: "object";
  properties: Record<string, { type: string; description: string; items?: unknown; enum?: string[] }>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolSchema;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "read_file",
    description:
      "Read a file. Text and code come back with line numbers (use offset/limit for large files). PDFs, images (PNG, JPEG, HEIC…), Word, PowerPoint, Excel, Pages, Keynote and Numbers files come back as each page's words, the words inside its pictures (screenshots, scans), and a picture of each page — up to 20 pages per read (pictures for 8); use pages for more. Paths may be relative to the project folder.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        offset: { type: "integer", description: "Text files: first line to read (1-based)" },
        limit: { type: "integer", description: "Text files: number of lines to read" },
        pages: { type: "string", description: "PDFs: which pages, e.g. '1-8', '21-36' or '3,5'" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create a new file or completely replace an existing one with the given content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        content: { type: "string", description: "Complete file content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact string in a file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true. Read the file first.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        old_string: { type: "string", description: "Exact text to replace" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: { type: "boolean", description: "Replace every occurrence" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "list_directory",
    description: "List the files and folders inside a folder.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Folder path ('.' for the project folder)" } },
      required: ["path"],
    },
  },
  {
    name: "find_files",
    description:
      "Find files or folders by name using a glob pattern such as '*.ts' or 'E.V'. Searches the project folder (or `path`); set everywhere=true to search the whole Mac with Spotlight.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Name or glob pattern" },
        path: { type: "string", description: "Folder to search (defaults to the project folder)" },
        everywhere: { type: "boolean", description: "Search the entire Mac with Spotlight" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "search_files",
    description: "Search text and code file contents with a regular expression (case-insensitive). Returns matching lines with file and line numbers. It can't look inside PDFs, images or Office files — open those with read_file.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression" },
        path: { type: "string", description: "Folder or file to search (defaults to the project folder)" },
        glob: { type: "string", description: "Only search files matching this glob, e.g. '*.py'" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command (zsh) in the project folder and return its output. Use for builds, tests, git, package managers. Not for interactive programs. For servers, watchers and long jobs set background=true: it keeps running while you work; read it with command_output and stop it with command_stop.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to run" },
        timeout_seconds: { type: "integer", description: "Maximum run time (default 120, max 1800)" },
        background: { type: "boolean", description: "Keep it running in the background and return at once" },
      },
      required: ["command"],
    },
  },
  {
    name: "web_fetch",
    description: "Download a web page and return its text.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "http(s) URL" } },
      required: ["url"],
    },
  },
  {
    name: "web_search",
    description:
      "Search the web. Returns the top results with titles, links and short snippets. Snippets rarely hold the full answer: after one search (two at most), open the best result with web_fetch instead of searching again.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Search query" } },
      required: ["query"],
    },
  },
  {
    name: "get_weather",
    description: "Live weather: current conditions and a daily forecast for a place. Always use this for weather instead of web search.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City with state or country, e.g. 'Springfield, CA' or 'Paris, France' (or 'lat,lon')" },
        days: { type: "integer", description: "Forecast days, 1–14 (default 3)" },
      },
      required: ["location"],
    },
  },
  {
    name: "sports",
    description:
      "Live sports data from ESPN: schedules, live scores and results (kind 'scores'), or standings (kind 'standings'). Times come back in the user's time zone. F1 lists every session (practice, sprint, qualifying, race).",
    parameters: {
      type: "object",
      properties: {
        league: { type: "string", description: "League", enum: SPORTS_LEAGUES },
        kind: { type: "string", description: "'scores' (schedule, live and recent results) or 'standings'", enum: ["scores", "standings"] },
        date: { type: "string", description: "Optional day, YYYY-MM-DD (default: current week or event)" },
      },
      required: ["league"],
    },
  },
  {
    name: "wikipedia",
    description: "Look something up on Wikipedia: a summary of the best-matching article (people, places, history, science, definitions).",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "What to look up" } },
      required: ["query"],
    },
  },
  {
    name: "convert_time",
    description:
      "Convert a date and time between time zones exactly. Use it for every time you give the user that comes from another zone (UTC, a race's local time, another city). Leave to_timezone empty for the user's own zone. time 'now' gives the current time in to_timezone.",
    parameters: {
      type: "object",
      properties: {
        time: { type: "string", description: "'YYYY-MM-DD HH:MM' (24-hour), an ISO time with Z/offset, or 'now'" },
        from_timezone: { type: "string", description: "IANA zone (e.g. Asia/Singapore) or UTC; ignored when time has Z/offset" },
        to_timezone: { type: "string", description: "IANA zone; empty = the user's time zone" },
      },
      required: ["time"],
    },
  },
  {
    name: "calculate",
    description: "Evaluate arithmetic exactly: + - * / % ^, parentheses, sqrt, abs, round, floor, ceil, log, ln, exp, sin/cos/tan (radians), min, max, pi, e. Use for any math instead of computing in your head.",
    parameters: {
      type: "object",
      properties: { expression: { type: "string", description: "e.g. '(1299 * 0.85) / 12'" } },
      required: ["expression"],
    },
  },
  {
    name: "convert_units",
    description: "Convert a value between units exactly: length, mass, volume, speed, area, data, time, temperature (C/F/K).",
    parameters: {
      type: "object",
      properties: {
        value: { type: "number", description: "Amount" },
        from: { type: "string", description: "Unit, e.g. 'km', 'lb', 'F', 'cups', 'GB'" },
        to: { type: "string", description: "Target unit" },
      },
      required: ["value", "from", "to"],
    },
  },
  {
    name: "todo_write",
    description: "Write the task list for a multi-step job. Send the full list each time; mark exactly one item in_progress.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The full task list",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Task" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "State" },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
  {
    name: "load_skill",
    description: "Load the full instructions of one of the user's skills (listed in the system prompt) before following it.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Skill name" } },
      required: ["name"],
    },
  },
  ...WORK_TOOL_DEFINITIONS,
  ...MEMORY_TOOL_DEFINITIONS,
  ...MAC_TOOL_DEFINITIONS,
  ...BROWSER_TOOL_DEFINITIONS,
  {
    name: "propose_plan",
    description:
      "Before a job that changes things (file edits, commands, scripts, quitting apps, Mac settings), show the user the plan — never for opening, looking, clicking, typing, browsing or messaging in apps (sends get their own approval when you press Send). They approve it once; everything inside it then runs without asking again. If you later need something outside the plan, or find a better approach, call this again with change_reason — never just switch.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short job name, e.g. 'Fix the login bug'" },
        steps: { type: "array", description: "Plain-language steps, in order", items: { type: "string" } },
        files: { type: "array", description: "Files or folders it may change (relative to the project; end with / for a folder)", items: { type: "string" } },
        commands: { type: "array", description: "Exact commands it may run, e.g. 'npm test'", items: { type: "string" } },
        apps: { type: "array", description: "Apps it may control with scripts, quit, or look at", items: { type: "string" } },
        access: { type: "array", description: "Extra access: 'screen' (whole screen), 'clipboard' (read)", items: { type: "string" } },
        change_reason: { type: "string", description: "Only when replacing an approved plan: why the new plan is better" },
      },
      required: ["title", "steps"],
    },
  },
  {
    name: "plan_progress",
    description: "Tick off the approved plan as you go: mark a step 'doing', 'done' or 'skipped'.",
    parameters: {
      type: "object",
      properties: {
        step: { type: "integer", description: "Step number (1 = first)" },
        status: { type: "string", description: "New status", enum: ["doing", "done", "skipped"] },
      },
      required: ["step", "status"],
    },
  },
];

/**
 * auto: runs without a card · ask: card (in Talk mode "approve" works inside an approval window)
 * · strict: card that always needs the full passphrase in Talk mode.
 */
export type Approval = "auto" | "ask" | "strict";

export interface ApprovalContext {
  cwd: string;
  home: string;
  /** The user picked a project folder for this chat (without one, nothing on the Mac is free). */
  hasProject: boolean;
  /** This context has already looked at local files, so a web request could carry them out. */
  readLocal: boolean;
}

/** Helpers that touch neither the Mac nor the network. */
const INTERNAL = new Set(["todo_write", "load_skill", "calculate", "convert_units", "convert_time", "document_part", "command_output", "command_stop", "ask_user", "agent", ...MEMORY_TOOLS]);

/** Free live-data services: no files, no personal data; same footing as web search. */
const LIVE_DATA = new Set(["get_weather", "sports", "wikipedia"]);

/** Tools that read the outside world; using them marks an answer for fact-checking. */
export const RESEARCH_TOOLS = new Set(["web_search", "web_fetch", "get_weather", "sports", "wikipedia"]);

/** Actions that only look at the Mac. Their output counts as local data for `readLocal`. */
export const LOOKS_LOCAL = new Set(["read_file", "list_directory", "find_files", "search_files", "run_command"]);

const VERSION_SHORT_FLAGS: Record<string, string> = {
  node: "-v", npm: "-v", pnpm: "-v", yarn: "-v", bun: "-v", deno: "-V", python: "-V", python3: "-V", cargo: "-V", rustc: "-V",
};

/** A path argument that stays inside the folder the command runs in. */
const isLocalPath = (token: string) => !token.startsWith("/") && !token.startsWith("-") && !token.split("/").includes("..");

/**
 * Look-only commands that run without a card: ls, pwd, git status / diff / log and version
 * checks, typed plainly. Anything chained, redirected, substituted or globbed asks.
 */
export function isSafeCommand(command: string): boolean {
  const line = command.trim();
  // echo only prints: safe as long as nothing is redirected, chained, substituted or expanded.
  if (/^echo(\s|$)/.test(line)) return !/[;&|<>`$(){}\\\n\r*?!~]/.test(line);
  if (!line || /[;&|<>`$(){}*?!~'"\\\n\r]/.test(line)) return false;
  const [program, ...rest] = line.split(/\s+/);
  if (program === "pwd") return rest.length === 0;
  // Reading files inside the project: counting, first/last lines, contents, file type.
  if (["wc", "head", "tail", "cat", "file"].includes(program)) {
    return rest.length > 0 && rest.some((t) => !t.startsWith("-")) && rest.every((t) => /^-[A-Za-z]+$|^-n$|^-\d+$|^\d+$/.test(t) || isLocalPath(t));
  }
  if (program === "ls") return rest.every((t) => /^-[A-Za-z1@]+$/.test(t) || isLocalPath(t));
  if (program === "git") {
    const [sub, ...args] = rest;
    if (!["status", "diff", "log"].includes(sub ?? "")) return false;
    return args.every(
      (t) =>
        // External diff tools, text converters and --output can run programs or write files.
        !/output|ext-diff|textconv|exec/i.test(t) && (/^--?[A-Za-z][\w-]*(=[\w.-]+)?$/.test(t) || /^-?\d+$/.test(t) || isLocalPath(t)),
    );
  }
  if (rest.length === 1 && /^[a-z][\w.+-]*$/.test(program)) {
    return rest[0] === "--version" || VERSION_SHORT_FLAGS[program] === rest[0];
  }
  return false;
}

/** Commands that delete files or folders always need the full passphrase. */
export function isDeleteCommand(command: string): boolean {
  return (
    /(^|[\s;&|(`])(sudo\s+)?(rm|rmdir|unlink|trash|shred|srm)(\s|$)/.test(command) ||
    /\s-delete(\s|$)/.test(command) ||
    /\bgit\s+clean\b/.test(command) ||
    /\bdiskutil\s+(erase|zero|secureErase)/i.test(command)
  );
}

/** Decides, by fixed rule, whether an action runs freely, needs a card, or needs the passphrase. */
export function approvalFor(name: string, args: Record<string, unknown>, ctx: ApprovalContext): Approval {
  if (INTERNAL.has(name) || LIVE_DATA.has(name) || name === "web_search") return "auto";
  // A page request after reading local files could smuggle their contents out in the URL.
  if (name === "web_fetch") return ctx.readLocal ? "ask" : "auto";
  const outside = !ctx.hasProject || reachesOutside(name, args, ctx.cwd, ctx.home);
  switch (name) {
    case "read_file":
    case "list_directory":
    case "find_files":
    case "search_files":
      return outside ? "strict" : "auto";
    case "write_file":
    case "edit_file":
    case "make_document":
      return outside ? "strict" : "ask";
    case "run_command": {
      const command = str(args.command);
      if (!ctx.hasProject || isDeleteCommand(command)) return "strict";
      return isSafeCommand(command) ? "auto" : "ask";
    }
    default:
      return "strict";
  }
}

/** Short spoken version of an action, e.g. "edit 3 lines in App.tsx". */
export function spokenAction(step: { name: string; args: Record<string, unknown>; preview?: ToolPreview }): string {
  const file = (p: unknown) => str(p).split("/").filter(Boolean).pop() || str(p);
  const { name, args, preview } = step;
  switch (name) {
    case "write_file":
      return preview?.kind === "diff" && preview.isNew ? `create ${file(args.path)}` : `rewrite ${file(args.path)}`;
    case "make_document":
      return `make the document ${file(args.path)}`;
    case "edit_file": {
      const changed = preview?.kind === "diff" ? preview.lines.filter((l) => l.kind === "add" || l.kind === "del").length : 0;
      return changed ? `edit ${changed} line${changed === 1 ? "" : "s"} in ${file(args.path)}` : `edit ${file(args.path)}`;
    }
    case "run_command": {
      const command = str(args.command).replace(/\s+/g, " ");
      return `run ${command.length > 60 ? `${command.slice(0, 57)}…` : command}`;
    }
    case "read_file":
      return `read ${file(args.path)} outside the project`;
    case "list_directory":
      return `look inside the folder ${file(args.path) || "home"}`;
    case "find_files":
      return args.everywhere ? `search your Mac for ${str(args.pattern)}` : `search for ${str(args.pattern)} outside the project`;
    case "search_files":
      return `search files outside the project for ${str(args.pattern)}`;
    case "web_fetch":
      return `open the web page ${str(args.url).replace(/^https?:\/\//, "").split("/")[0]}`;
    default:
      return describeTool(name, args).toLowerCase();
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export interface ToolEnv {
  cwd: string;
  home: string;
  /** Web search through Gemini's Google Search grounding. */
  webSearch: (query: string, signal: AbortSignal) => Promise<string>;
  signal: AbortSignal;
  /** Reads JSON from the allowlisted live-data services. */
  fetchJson?: FetchJson;
  /** Mac control: final-action approvals, task apps and undo. */
  mac?: MacEnv;
  /** The chat and the step being run, for memory and schedule tools. */
  memory?: { chatId: string; chatTitle: string; stepId: string; userText?: string };
  /** Searches made so far in this task; capped so models open results instead of re-searching. */
  searches?: number;
  /** Which E.V Browser tab this agent uses ("main", or one per helper). */
  browserTab?: string;
  /** Pages of the documents read in this task ("<path>#<page>" → words), so a document made from them can be checked against them. */
  sourcePages?: Record<string, string>;
  /** Documents the user attached in this conversation (used as the source when none were read). */
  attachedDocuments?: string[];
  /** How many times each document was made in this task. */
  madeVersions?: Record<string, number>;
  /** Pages of each PDF read in this task. */
  pagesRead?: PagesRead;
  /** Sections written with document_part, per document. */
  documentParts?: Record<string, string[]>;
  /** Source pages condense_document couldn't turn into a section yet, per document. */
  documentGaps?: Record<string, number[]>;
}

export const MAX_SEARCHES_PER_TASK = 3;

/** Absolute, normalised form of a tool path (for cards and the outside-folder check). */
export function absolutePath(path: string, cwd: string, home: string): string {
  let p = path.trim() || ".";
  if (p === "~" || p.startsWith("~/")) p = home + p.slice(1);
  else if (!p.startsWith("/")) p = `${cwd.replace(/\/$/, "")}/${p}`;
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

export function isInside(path: string, folder: string): boolean {
  const base = folder.replace(/\/$/, "");
  return path === base || path.startsWith(`${base}/`);
}

/** Short description for the card header. */
export function describeTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "load_tools":
      return `Load more tools (${Array.isArray(args.groups) ? args.groups.join(", ") : ""})`;
    case "read_file":
      return `Read ${str(args.path)}${args.pages ? ` (pages ${str(args.pages)})` : ""}`;
    case "write_file":
      return `Write ${str(args.path)}`;
    case "make_document":
      return `Make ${str(args.path)}`;
    case "condense_document":
      return `Condense ${str(args.source).split("/").pop()}${args.pages ? ` (pages ${str(args.pages)})` : ""}`;
    case "document_part":
      return args.replace ? `Rewrite part ${str(args.replace)} of ${str(args.path).split("/").pop()}` : `Write a part of ${str(args.path).split("/").pop()}`;
    case "command_output":
      return `Check background command ${str(args.id)}`;
    case "command_stop":
      return `Stop background command ${str(args.id)}`;
    case "ask_user":
      return str(args.question) || "Question";
    case "agent":
      return `Agent: ${str(args.description) || "sub-task"}`;
    case "edit_file":
      return `Edit ${str(args.path)}`;
    case "list_directory":
      return `List folder ${str(args.path) || "."}`;
    case "find_files":
      return args.everywhere ? `Search this Mac for "${str(args.pattern)}"` : `Find "${str(args.pattern)}" in ${str(args.path) || "the project folder"}`;
    case "search_files":
      return `Search file contents for /${str(args.pattern)}/`;
    case "run_command":
      return args.background === true ? "Run in the background" : "Run command";
    case "web_fetch":
      return `Open web page ${str(args.url)}`;
    case "web_search":
      return `Search the web for "${str(args.query)}"`;
    case "propose_plan":
      return `Plan: ${str(args.title)}`;
    case "plan_progress":
      return "Plan progress";
    case "split_into_helpers":
      return `Split into ${Array.isArray(args.parts) ? args.parts.length : ""} helpers`.replace("  ", " ");
    case "remember":
      return "Learned";
    case "forget":
      return "Forgot";
    case "suggest_memory":
      return "Remember this?";
    case "schedule_add":
      return "Scheduled";
    case "schedule_update":
      return "Schedule changed";
    case "schedule_delete":
      return "Removed from schedule";
    case "schedule_list":
      return "Checked schedule";
    case "get_weather":
      return `Check weather for ${str(args.location)}`;
    case "sports":
      return `Check ${str(args.league).toUpperCase()} ${args.kind === "standings" ? "standings" : "scores and schedule"}${args.date ? ` for ${str(args.date)}` : ""}`;
    case "wikipedia":
      return `Look up "${str(args.query)}" on Wikipedia`;
    case "convert_time":
      return `Convert ${str(args.time)}${args.from_timezone ? ` ${str(args.from_timezone)}` : ""} to ${str(args.to_timezone) || "your time"}`;
    case "calculate":
      return `Calculate ${str(args.expression)}`;
    case "convert_units":
      return `Convert ${str(args.value)} ${str(args.from)} to ${str(args.to)}`;
    case "todo_write":
      return "Update task list";
    case "load_skill":
      return `Load skill "${str(args.name)}"`;
    default:
      if (isConnectionTool(name)) return describeConnectionTool(name, args);
      if (name.startsWith("browser_") || name === "make_graph") return describeBrowserTool(name, args);
      return MAC_TOOLS.has(name) ? describeMacTool(name, args) : `Unknown action ${name}`;
  }
}

/** Paths an action touches, for the outside-the-project-folder warning. */
function touchedPaths(name: string, args: Record<string, unknown>): string[] {
  switch (name) {
    case "read_file":
    case "write_file":
    case "edit_file":
    case "make_document":
    case "list_directory":
      return [str(args.path) || "."];
    case "find_files":
      return args.everywhere ? ["/"] : [str(args.path) || "."];
    case "search_files":
      return [str(args.path) || "."];
    default:
      return [];
  }
}

export function reachesOutside(name: string, args: Record<string, unknown>, cwd: string, home: string): boolean {
  return touchedPaths(name, args).some((p) => !isInside(absolutePath(p, cwd, home), absolutePath(cwd, cwd, home)));
}

/** Builds what the approval card shows: the exact command, the exact lines changed, or the target. */
export async function buildPreview(name: string, args: Record<string, unknown>, cwd: string, home: string): Promise<ToolPreview | undefined> {
  const path = absolutePath(str(args.path) || ".", cwd, home);
  switch (name) {
    case "run_command":
      return { kind: "command", command: str(args.command), cwd };
    case "write_file": {
      const current = await toolReadFile(cwd, str(args.path)).catch(() => null);
      const before = current?.exists ? current.content : "";
      const diff = lineDiff(before, str(args.content));
      return { kind: "diff", path, isNew: !current?.exists, ...diff };
    }
    case "edit_file": {
      const current = await toolReadFile(cwd, str(args.path)).catch(() => null);
      if (!current?.exists) return { kind: "target", label: "File (not found)", value: path };
      const oldString = str(args.old_string);
      const after = args.replace_all
        ? current.content.split(oldString).join(str(args.new_string))
        : current.content.replace(oldString, () => str(args.new_string));
      return { kind: "diff", path, isNew: false, ...lineDiff(current.content, after) };
    }
    case "condense_document":
      return { kind: "target", label: "Read and condense", value: absolutePath(str(args.source), cwd, home) };
    case "make_document":
      return { kind: "target", label: `New ${(str(args.format) || /\.([a-z]+)$/i.exec(str(args.path))?.[1] || "pdf").toUpperCase()} document`, value: path };
    case "read_file": {
      const range = num(args.offset) || num(args.limit) ? ` (lines ${num(args.offset) ?? 1}–${(num(args.offset) ?? 1) + (num(args.limit) ?? 0) - 1 || "end"})` : "";
      return { kind: "target", label: "File", value: path + range };
    }
    case "list_directory":
      return { kind: "target", label: "Folder", value: path };
    case "find_files":
      return { kind: "target", label: args.everywhere ? "Whole Mac (Spotlight)" : "In folder", value: args.everywhere ? `name matches "${str(args.pattern)}"` : `${path}  ·  name matches "${str(args.pattern)}"` };
    case "search_files":
      return { kind: "target", label: "In", value: `${path}${args.glob ? `  ·  files ${str(args.glob)}` : ""}  ·  /${str(args.pattern)}/` };
    case "web_fetch":
      return { kind: "target", label: "URL", value: str(args.url) };
    case "web_search":
      return { kind: "target", label: "Query", value: str(args.query) };
    default:
      return undefined;
  }
}

export interface ToolOutcome {
  /** What the model receives. */
  output: string;
  /** Shorter version shown under the card. */
  display: string;
  ok: boolean;
  undo?: UndoInfo;
  /** JPEG (base64) the model sees along with the result. */
  image?: string;
  /** Several pictures (document pages), in order. */
  images?: string[];
  /** make_graph: the graph shown in the chat. */
  graph?: GraphResult;
  /** make_document: what still fails E.V's checks for that file. */
  documentProblems?: { path: string; problems: string[] };
  /** Mac actions: whether the window showed it worked, and how to repeat it without the AI. */
  confirmed?: boolean;
  replay?: ReplayStep[] | null;
}

const MODEL_OUTPUT_LIMIT = 40_000;
const DISPLAY_LIMIT = 2_000;

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…[${(text.length - limit).toLocaleString()} more characters]` : text;
}

function done(output: string, ok = true): ToolOutcome {
  return { output: clip(output, MODEL_OUTPUT_LIMIT), display: clip(output, DISPLAY_LIMIT), ok };
}

const liveFetch = (env: ToolEnv): FetchJson =>
  env.fetchJson ?? (async (url: string) => JSON.parse(await liveFetchJson(url)));

/**
 * The parts written for a document. If the path doesn't match exactly (models often vary it between
 * calls) and this task wrote parts for just one document, those are the ones meant.
 */
function partsFor(env: ToolEnv, key: string): string[] {
  const exact = env.documentParts?.[key];
  if (exact?.length) return exact;
  const all = Object.values(env.documentParts ?? {}).filter((p) => p.length);
  return all.length === 1 ? all[0] : [];
}

/** Runs an approved action. Errors come back as text so the model can react to them. */
export async function executeTool(name: string, args: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  const { cwd } = env;
  try {
    switch (name) {
      case "read_file": {
        if (isDocumentPath(str(args.path))) {
          const doc = await readDocument(cwd, str(args.path), str(args.pages) || undefined);
          env.sourcePages = { ...env.sourcePages, ...doc.blocks };
          if (doc.pageCount) {
            const before = env.pagesRead?.[doc.path]?.read ?? [];
            env.pagesRead = { ...env.pagesRead, [doc.path]: { total: doc.pageCount, read: [...before, ...doc.pagesRead] } };
          }
          return { output: clip(doc.output, MODEL_OUTPUT_LIMIT * 3), display: doc.display, ok: true, images: doc.images };
        }
        const file = await toolReadFile(cwd, str(args.path), num(args.offset), num(args.limit));
        if (!file.exists) return done(`File not found: ${file.path}`, false);
        const start = num(args.offset) ?? 1;
        const numbered = file.content
          .split("\n")
          .map((line, i) => `${String(start + i).padStart(5)}\t${line}`)
          .join("\n");
        return {
          output: clip(`${file.path} (${file.totalLines} lines)\n${numbered}`, MODEL_OUTPUT_LIMIT),
          display: `${file.path} · ${file.totalLines} lines`,
          ok: true,
        };
      }
      case "write_file":
        return done(await toolWriteFile(cwd, str(args.path), str(args.content)));
      case "edit_file":
        return done(await toolEditFile(cwd, str(args.path), str(args.old_string), str(args.new_string), args.replace_all === true));
      case "list_directory":
        return done(await toolListDirectory(cwd, str(args.path) || "."));
      case "find_files":
        return done(await toolFindFiles(cwd, str(args.pattern), str(args.path) || undefined, args.everywhere === true));
      case "search_files": {
        if (isDocumentPath(str(args.path)) || isDocumentPath(str(args.glob).replace(/^\*/, "x"))) {
          return done(`search_files can't look inside ${str(args.path) || str(args.glob)} — PDFs, images and Office files hold their words in pages and pictures. Open it with read_file (pages="…" for a range).`, false);
        }
        const found = await toolSearchFiles(cwd, str(args.pattern), str(args.path) || undefined, str(args.glob) || undefined);
        return done(/^No matches/i.test(found.trim()) ? `${found}\n(search_files doesn't look inside PDFs, images or Office files — if the answer may be in one, open it with read_file.)` : found);
      }
      case "make_document": {
        // The model may have worked from an attached file without reading it through read_file:
        // the attachment is still the source the new document is checked against.
        if (!Object.keys(env.sourcePages ?? {}).length && env.attachedDocuments?.length) {
          for (const path of env.attachedDocuments) {
            const doc = await toolReadDocument(cwd, path, "1-50", false).catch(() => null);
            if (doc) env.sourcePages = { ...env.sourcePages, ...pageBlocks(doc) };
          }
        }
        const key = absolutePath(str(args.path), cwd, env.home);
        env.madeVersions = { ...env.madeVersions, [key]: (env.madeVersions?.[key] ?? 0) + 1 };
        const out = await makeDocument(cwd, args, env.memory?.userText ?? "", Object.values(env.sourcePages ?? {}), env.madeVersions[key], unreadPages(env.pagesRead, env.memory?.userText ?? ""), partsFor(env, key), env.documentGaps?.[key] ?? []);
        return { output: out.output, display: out.display, ok: out.ok, images: out.images, ...(out.path ? { documentProblems: { path: out.path, problems: out.problems } } : {}) };
      }
      case "document_part": {
        const key = absolutePath(str(args.path), cwd, env.home);
        const parts = [...(env.documentParts?.[key] ?? [])];
        const html = str(args.html).trim();
        if (!html) return done("Error: the part is empty.", false);
        const replace = num(args.replace);
        if (replace !== undefined && (replace < 1 || replace > parts.length)) return done(`Error: there's no part ${replace} (this document has ${parts.length}).`, false);
        if (replace !== undefined) parts[replace - 1] = html;
        else parts.push(html);
        env.documentParts = { ...env.documentParts, [key]: parts };
        // A part written by hand fills the gap condense_document left.
        if (replace === undefined && env.documentGaps?.[key]?.length) env.documentGaps = { ...env.documentGaps, [key]: [] };
        const words = parts.map(htmlWords);
        const n = replace ?? parts.length;
        return {
          output: `Part ${n} saved (${words[n - 1]} words). ${str(args.path).split("/").pop()} has ${parts.length} part${parts.length === 1 ? "" : "s"} (${words.reduce((a, b) => a + b, 0).toLocaleString()} words). Write the next part, or make_document with from_parts=true when every part is written.`,
          display: `Part ${n} · ${words[n - 1]} words`,
          ok: true,
        };
      }
      case "command_output":
        return done((await backgroundOutput(str(args.id), num(args.wait_seconds))).output);
      case "command_stop":
        return done((await stopBackground(str(args.id))).output);
      case "run_command": {
        if (args.background === true) {
          const out = await startBackground(cwd, str(args.command));
          return { output: out.output, display: out.display, ok: out.ok };
        }
        const taskId = uid("cmd-");
        const abort = () => void toolCancel(taskId).catch(() => {});
        env.signal.addEventListener("abort", abort, { once: true });
        try {
          const result = await toolRunCommand(cwd, str(args.command), taskId, num(args.timeout_seconds));
          const status = result.timedOut ? "timed out" : `exit code ${result.exitCode ?? "?"}`;
          return done(`$ ${str(args.command)}\n${result.output}\n[${status}]`, !result.timedOut && result.exitCode === 0);
        } finally {
          env.signal.removeEventListener("abort", abort);
        }
      }
      case "web_fetch":
        return done(await toolWebFetch(str(args.url)));
      case "web_search": {
        const query = str(args.query);
        env.searches = (env.searches ?? 0) + 1;
        if (env.searches > MAX_SEARCHES_PER_TASK) {
          return done(`Search limit reached (${MAX_SEARCHES_PER_TASK} per task). Open one of the results you already have with web_fetch, or answer with what you know.`, false);
        }
        try {
          return done(await toolWebSearch(query));
        } catch (err) {
          // Both free engines refused (DuckDuckGo and Bing); Gemini's Google Search is the last resort.
          const reason = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
          try {
            return done(await env.webSearch(query, env.signal));
          } catch {
            return done(`Error: web search failed (${reason}). Do not retry web_search in this task; open a specific site with web_fetch instead, or tell the user.`, false);
          }
        }
      }
      case "browser_go":
      case "browser_do":
      case "browser_look":
      case "browser_show":
      case "make_graph": {
        const out = await executeBrowserTool(name, args, env.browserTab ?? "main");
        return { output: clip(out.output, MODEL_OUTPUT_LIMIT), display: clip(out.display, DISPLAY_LIMIT), ok: out.ok, image: out.image, graph: out.graph };
      }
      case "mac_open":
      case "mac_look":
      case "mac_do":
      case "mac_front":
      case "mac_click":
      case "mac_drag":
      case "mac_menu":
      case "mac_tabs":
      case "mac_type":
      case "mac_key":
      case "mac_scroll":
      case "mac_media":
      case "mac_system":
      case "mac_screen":
      case "mac_applescript":
      case "mac_shortcut":
      case "mac_quit":
      case "mac_clipboard": {
        if (!env.mac) return done("Mac control isn't available in this context.", false);
        const out = await executeMacTool(name, args, env.mac);
        return { output: clip(out.output, MODEL_OUTPUT_LIMIT), display: clip(out.display, DISPLAY_LIMIT), ok: out.ok, image: out.image, confirmed: out.confirmed, replay: out.replay };
      }
      case "remember":
      case "forget":
      case "suggest_memory":
      case "schedule_add":
      case "schedule_update":
      case "schedule_delete":
      case "schedule_list":
        return await executeMemoryTool(name, args, env.memory ?? { chatId: "", chatTitle: "", stepId: "" });
      case "get_weather":
        return done(await weather(str(args.location), num(args.days) ?? 3, liveFetch(env)));
      case "sports":
        return done(await sports(str(args.league), str(args.kind) || "scores", str(args.date) || undefined, liveFetch(env)));
      case "wikipedia":
        return done(await wikipedia(str(args.query), liveFetch(env)));
      case "convert_time":
        return done(convertTime(str(args.time), str(args.from_timezone) || undefined, str(args.to_timezone) || undefined));
      case "calculate":
        return done(`${str(args.expression)} = ${formatNumber(calculate(str(args.expression)))}`);
      case "convert_units": {
        const value = num(args.value) ?? Number(str(args.value));
        return done(`${value} ${str(args.from)} = ${formatNumber(convertUnits(value, str(args.from), str(args.to)))} ${str(args.to)}`);
      }
      case "todo_write": {
        const todos = Array.isArray(args.todos) ? (args.todos as { content?: unknown; status?: unknown }[]) : [];
        const mark = (s: unknown) => (s === "completed" ? "[x]" : s === "in_progress" ? "[~]" : "[ ]");
        const list = todos.map((t) => `${mark(t.status)} ${str(t.content)}`).join("\n");
        return { output: "Task list updated.", display: list || "(empty)", ok: true };
      }
      case "load_skill": {
        if (REPLACED_SKILLS.has(str(args.name).trim().toLowerCase())) return done(REPLACED_SKILL_NOTE, false);
        const skill = await loadSkill(str(args.name));
        if (skill.claudeOnly) {
          return done(`The "${skill.name}" skill only works in Claude Code (it needs Claude-only tools). Tell the user.`, false);
        }
        const files = skill.files.length ? `\n\nOther files in this skill (read with read_file if needed, base ${skill.path}):\n${skill.files.join("\n")}` : "";
        return {
          output: clip(`${skill.content}${files}`, MODEL_OUTPUT_LIMIT),
          display: `Loaded ${skill.name}`,
          ok: true,
        };
      }
      default: {
        if (isConnectionTool(name)) {
          const out = await executeConnectionTool(name, args);
          return { output: clip(out.output, MODEL_OUTPUT_LIMIT), display: clip(out.output, DISPLAY_LIMIT), ok: out.ok, image: out.image };
        }
        return done(`Unknown action "${name}".`, false);
      }
    }
  } catch (err) {
    return done(`Error: ${typeof err === "string" ? err : err instanceof Error ? err.message : String(err)}`, false);
  }
}
