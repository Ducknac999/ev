import type { ToolDefinition } from "./tools";

/**
 * Which tool descriptions go with each AI call. Every call re-sends the whole list, so E.V sends a
 * small core — what Mac, browser and quick-answer tasks use — and keeps the rest in groups the AI
 * loads when a task needs them (load_tools, or by calling one of those tools by name). A chat keeps
 * what it loaded, so its list stays the same from call to call and the provider's cache covers it.
 */

export const CORE_TOOLS = new Set(["mac_open", "mac_look", "mac_click", "mac_type", "mac_key", "mac_tabs", "mac_scroll", "mac_front", "mac_media", "find_my_file", "web_search", "web_fetch"]);

export type ToolGroup = "basics" | "browser" | "files" | "documents" | "facts" | "schedule" | "plan" | "mac_more";

export const TOOL_GROUPS: Record<ToolGroup, string[]> = {
  basics: ["remember", "ask_user", "calculate", "load_skill", "mac_menu", "mac_system", "mac_quit"],
  browser: ["browser_go", "browser_do", "browser_look"],
  files: ["read_file", "write_file", "edit_file", "list_directory", "find_files", "search_files", "run_command", "command_output", "command_stop", "todo_write", "agent"],
  documents: ["read_file", "document_part", "make_document", "condense_document"],
  facts: ["get_weather", "sports", "wikipedia", "convert_time", "convert_units", "make_graph"],
  schedule: ["schedule_add", "schedule_update", "schedule_delete", "schedule_list", "forget", "suggest_memory"],
  plan: ["propose_plan", "plan_progress"],
  mac_more: ["mac_drag", "mac_do", "mac_screen", "mac_applescript", "mac_shortcut", "mac_clipboard", "browser_show"],
};

export const LOAD_TOOLS = "load_tools";

export const LOAD_TOOLS_DEFINITION: ToolDefinition = {
  name: LOAD_TOOLS,
  description:
    "More tools, loaded when a task needs them (they stay for this chat). basics: remember (save what the user teaches you or a lesson), ask_user (a choice only the user can make), calculate, load_skill, mac_menu (a menu bar item by name, e.g. \"File > Export as PDF…\"), mac_system (volume, brightness, dark mode), mac_quit. browser: the E.V Browser — browser_go, browser_do, browser_look (research, sites to work on without the user's own browser). files: read/write/edit files and folders, find/search, run_command, todo lists, sub-agents (agent). documents: make PDFs/Word (make_document), read long documents in parts, condense. facts: get_weather, sports, wikipedia, convert_time, convert_units, make_graph. schedule: calendar events and reminders, forget/suggest memory. plan: propose_plan for approval. mac_more: mac_drag (sliders, moving things), mac_do (several steps in one), mac_screen (picture of the screen), mac_applescript (Music, Finder, Notes, Reminders, Calendar, Mail), mac_shortcut, mac_clipboard, browser_show. Calling one of those tools by name also loads its group.",
  parameters: {
    type: "object",
    properties: { groups: { type: "array", items: { type: "string", enum: Object.keys(TOOL_GROUPS) }, description: "Groups to load" } },
    required: ["groups"],
  },
};

/** The group a tool belongs to (null for core tools and unknown names). */
export function groupOf(name: string): ToolGroup | null {
  if (CORE_TOOLS.has(name)) return null;
  for (const [group, names] of Object.entries(TOOL_GROUPS) as [ToolGroup, string[]][]) if (names.includes(name)) return group;
  return null;
}

/** Loaded groups per chat, for as long as E.V runs. */
const loaded = new Map<string, Set<ToolGroup>>();

export function loadedGroups(chatId: string): Set<ToolGroup> {
  let set = loaded.get(chatId);
  if (!set) loaded.set(chatId, (set = new Set()));
  return set;
}

/** Core tools plus the chat's groups, in the definitions' own order (stable for the cache). */
export function toolsFor(all: ToolDefinition[], groups: Set<ToolGroup>): ToolDefinition[] {
  const wanted = new Set(CORE_TOOLS);
  for (const group of groups) for (const name of TOOL_GROUPS[group]) wanted.add(name);
  return [...all.filter((t) => wanted.has(t.name)), LOAD_TOOLS_DEFINITION];
}
