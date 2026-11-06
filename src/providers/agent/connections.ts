import { connectionCall, connectionStart, connectionStop, type ConnectionTool } from "../../lib/ipc";
import type { ToolDefinition, ToolSchema } from "./tools";

/**
 * Tools from switched-on connections (MCP servers), offered to every AI as `c_<connection>__<tool>`.
 * Each call is classified here so the normal approval rules apply: reading → no approval, changing
 * → asks, sending/deleting → preview, money and passwords → never.
 */

export type ConnectionCategory = "browser" | "connected_read" | "connected_change" | "send" | "delete" | "money" | "passwords";

interface Registered {
  connection: string;
  tool: ConnectionTool;
}

const registry = new Map<string, Registered>();
const running = new Set<string>();

export const CONNECTION_NAMES: Record<string, string> = {
  browser: "E.V's browser",
  google: "Google",
  apple: "Apple apps",
  youtube: "YouTube",
  context7: "Context7",
  github: "GitHub",
  notion: "Notion",
};

/** Gemini function names: letters, digits, _ . : -, at most 64 characters. */
export function toolName(connection: string, tool: string): string {
  return `c_${connection}__${tool.replace(/[^a-zA-Z0-9_.:-]/g, "_")}`.slice(0, 64);
}

export const isConnectionTool = (name: string) => name.startsWith("c_") && registry.has(name);

/** Starts what's switched on and stops what isn't. Returns errors per connection. */
export async function syncConnections(wanted: string[]): Promise<Record<string, string>> {
  const errors: Record<string, string> = {};
  for (const id of [...running]) {
    if (!wanted.includes(id)) {
      running.delete(id);
      for (const [name, r] of registry) if (r.connection === id) registry.delete(name);
      await connectionStop(id).catch(() => {});
    }
  }
  await Promise.all(
    wanted
      .filter((id) => !running.has(id))
      .map(async (id) => {
        try {
          const tools = await connectionStart(id);
          running.add(id);
          for (const tool of tools) registry.set(toolName(id, tool.name), { connection: id, tool });
        } catch (err) {
          errors[id] = String(err);
        }
      }),
  );
  return errors;
}

export const runningConnections = () => [...running];

/** Gemini accepts an OpenAPI-style subset of JSON Schema. */
export function cleanSchema(schema: unknown, depth = 0): Record<string, unknown> {
  const s = (schema && typeof schema === "object" ? schema : {}) as Record<string, unknown>;
  const variants = (s.anyOf ?? s.oneOf) as Record<string, unknown>[] | undefined;
  if (Array.isArray(variants) && variants.length) {
    const first = variants.find((v) => v?.type !== "null") ?? variants[0];
    return { ...cleanSchema(first, depth), ...(typeof s.description === "string" ? { description: s.description } : {}) };
  }
  let type = Array.isArray(s.type) ? (s.type as string[]).find((t) => t !== "null") : (s.type as string | undefined);
  if (!type) type = s.properties ? "object" : "string";
  if (type === "integer" || type === "number" || type === "boolean" || type === "string" || type === "array" || type === "object") {
    /* supported */
  } else type = "string";
  const out: Record<string, unknown> = { type };
  if (typeof s.description === "string") out.description = s.description.slice(0, 1000);
  if (Array.isArray(s.enum) && type === "string") out.enum = s.enum.filter((e) => e !== null).map(String);
  if (type === "object") {
    const props = (s.properties ?? {}) as Record<string, unknown>;
    out.properties = depth > 6 ? {} : Object.fromEntries(Object.entries(props).map(([k, v]) => [k, cleanSchema(v, depth + 1)]));
    const required = Array.isArray(s.required) ? (s.required as string[]).filter((r) => r in props) : [];
    if (required.length) out.required = required;
  }
  if (type === "array") out.items = cleanSchema(s.items ?? { type: "string" }, depth + 1);
  return out;
}

export function connectionToolDefinitions(): ToolDefinition[] {
  return [...registry.entries()].map(([name, { connection, tool }]) => {
    const params = cleanSchema(tool.inputSchema);
    return {
      name,
      description: `[${CONNECTION_NAMES[connection] ?? connection}] ${tool.description}`.slice(0, 1024),
      parameters: { type: "object", properties: (params.properties ?? {}) as ToolSchema["properties"], ...(params.required ? { required: params.required as string[] } : {}) },
    };
  });
}

const MONEY = /\b(pay(ment|ing)?|purchase|checkout|check out|buy( now)?|place (your )?order|add to cart|bank|venmo|paypal|zelle|cash ?app|credit card|debit card|card number|cvv|crypto|bitcoin|wallet|transfer funds|wire)\b/i;
const MONEY_SITES = /(amazon\.[a-z.]+\/(gp\/)?(cart|buy|checkout)|checkout|paypal\.com|venmo\.com|chase\.com|bankofamerica\.com|wellsfargo\.com|coinbase\.com|robinhood\.com|stripe\.com|cash\.app)/i;
const PASSWORD = /\b(password|passcode|passwd|2fa|one[- ]time code|otp|security code|verification code|pin code)\b/i;
const SENDS = /(send|reply|forward|post|publish|share|invite|comment|submit|merge|create_pull_request|push_files|create_issue|draft_send)/i;
const DELETES = /(delete|remove|trash|archive|erase|purge|close_issue|cancel_event)/i;
const READS = /^(get|list|search|read|find|fetch|query|retrieve|view|show|describe|check|lookup|resolve|browser_snapshot|browser_take_screenshot|browser_tabs|browser_console|browser_network|browser_wait)/i;
const BROWSER_ACTS = /^browser_(click|type|press_key|select_option|fill_form|drag|hover|file_upload|handle_dialog|evaluate)$/;

/** Which approval rule applies to this call. */
export function connectionCategory(name: string, args: Record<string, unknown>): ConnectionCategory {
  const r = registry.get(name);
  if (!r) return "connected_change";
  const { connection, tool } = r;
  const argText = JSON.stringify(args ?? {});
  if (connection === "youtube" || connection === "context7") return "connected_read";
  if (PASSWORD.test(tool.name) || PASSWORD.test(argText)) return "passwords";
  if (MONEY_SITES.test(argText) || (connection !== "browser" && MONEY.test(tool.name))) return "money";

  if (connection === "browser") {
    if (BROWSER_ACTS.test(tool.name)) {
      // What's being clicked or typed into ("element": "Place order button").
      if (MONEY.test(argText)) return "money";
      if (/\b(send|submit|post|publish|confirm|sign up|subscribe|reply)\b/i.test(argText)) return "send";
      if (/\b(delete|remove|unsubscribe|cancel)\b/i.test(argText)) return "delete";
    }
    if (tool.name === "browser_evaluate" || tool.name === "browser_file_upload") return "connected_change";
    return "browser";
  }

  if (tool.readOnly || READS.test(tool.name)) return "connected_read";
  if (SENDS.test(tool.name)) return "send";
  if (DELETES.test(tool.name) || tool.destructive) return "delete";
  return "connected_change";
}

export function describeConnectionTool(name: string, args: Record<string, unknown>): string {
  const r = registry.get(name);
  if (!r) return name;
  const label = CONNECTION_NAMES[r.connection] ?? r.connection;
  const readable = r.tool.name.replace(/^browser_/, "").replace(/[_-]+/g, " ");
  const detail = typeof args.url === "string" ? ` ${args.url}` : typeof args.element === "string" ? ` “${args.element}”` : typeof args.query === "string" ? ` “${args.query}”` : "";
  return `${label}: ${readable}${detail}`.slice(0, 140);
}

export async function executeConnectionTool(name: string, args: Record<string, unknown>): Promise<{ output: string; ok: boolean; image?: string }> {
  const r = registry.get(name);
  if (!r) return { output: "That connection is switched off.", ok: false };
  const result = await connectionCall(r.connection, r.tool.name, args);
  const text = result.text.length > 30_000 ? `${result.text.slice(0, 30_000)}\n… (cut)` : result.text;
  return { output: text || (result.images.length ? "(picture)" : "(no output)"), ok: !result.error, image: result.images[0] };
}

/** For tests: registers a tool without a running server. */
export function registerForTest(connection: string, tool: Partial<ConnectionTool> & { name: string }): string {
  const name = toolName(connection, tool.name);
  registry.set(name, { connection, tool: { description: "", inputSchema: { type: "object", properties: {} }, readOnly: false, destructive: false, ...tool } });
  return name;
}
