import { emitTo } from "@tauri-apps/api/event";
import { fileOpen, findMyFiles, type FileHit } from "../lib/ipc";

/**
 * "Find my resume" without the AI: Spotlight, ranked (src-tauri/src/files.rs). One clear match
 * opens; a close call shows the best few — in the chat and the notch — to pick by number
 * ("the second one") or click. The pick is remembered for the same words next time.
 */

const PICKS_KEY = "ev.filePicks";
const PICK_MS = 3 * 60_000;

let pending: { key: string; results: FileHit[]; at: number } | null = null;

function picks(): Record<string, string> {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(PICKS_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function remember(key: string, path: string): void {
  if (!key) return;
  const all = picks();
  delete all[key];
  all[key] = path;
  // The newest 200 picks.
  const entries = Object.entries(all).slice(-200);
  globalThis.localStorage?.setItem(PICKS_KEY, JSON.stringify(Object.fromEntries(entries)));
}

const ORDINALS: Record<string, number> = { first: 1, "1st": 1, one: 1, second: 2, "2nd": 2, two: 2, third: 3, "3rd": 3, three: 3, fourth: 4, "4th": 4, four: 4, fifth: 5, "5th": 5, five: 5 };

/** "the second one", "open number 2", "3" — only right after E.V showed a list. */
export function parsePick(text: string): number | null {
  if (!pending || Date.now() - pending.at > PICK_MS) return null;
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, "");
  const m = /^(?:open\s+|pick\s+|choose\s+)?(?:the\s+)?(?:number\s+|no\.?\s*|#)?(first|1st|one|second|2nd|two|third|3rd|three|fourth|4th|four|fifth|5th|five|[1-5])(?:\s+(?:one|file))?(?:\s+please)?$/.exec(t);
  if (!m) return null;
  const n = ORDINALS[m[1]] ?? Number(m[1]);
  return n >= 1 && n <= pending.results.length ? n : null;
}

/** Whether a request is about a file of yours ("find my resume", "open my tax PDF"), not an app. */
export function fileRequest(text: string): string | null {
  const t = text.trim().replace(/[.!?]+$/, "");
  if (t.length > 90) return null;
  const lead = /^(?:(?:hey\s+)?(?:e\.?\s?v\.?|evie|eevee)[,\s]+)?(?:can\s+you\s+|could\s+you\s+|please\s+)?/i;
  const rest = t.replace(lead, "");
  // "open my downloads folder": a place, not a file — mac_open does it.
  if (/^(?:open|show)\s+(?:me\s+)?(?:my|the)\s+(?:downloads|desktop|documents|pictures|movies|music|home|applications|trash)(?:\s+folder)?$/i.test(rest)) return null;
  if (/^(?:find|locate|where(?:'s|\s+is|\s+are)?|search\s+for)\s+(?:my|the|a|that)\b/i.test(rest)) return rest;
  // "open my resume", "open the tax return PDF", "pull up my essay": a file, not an app.
  if (/^(?:open|show|pull\s+up|bring\s+up)\s+(?:me\s+)?(?:my|the\s+(?:latest|newest|last|most\s+recent))\b/i.test(rest)) return rest;
  if (/^(?:open|show|pull\s+up)\s+.+\b(?:pdf|docx?|file|document|spreadsheet|slides|presentation|screenshot|photo|folder)$/i.test(rest)) return rest;
  return null;
}

function list(results: FileHit[], named: boolean): string {
  const lines = results.slice(0, 5).map((r, i) => `${i + 1}. **${r.name}** · ${r.folder}${r.when ? ` · ${r.when}` : ""}`);
  return `${named ? "Which one?" : "Nothing's named that — these mention it:"}\n\n${lines.join("\n")}\n\nSay “the first one” (or its number), or click it in the notch.`;
}

/** Runs a file request. Throws when Spotlight finds nothing, so the AI can take it from there. */
export async function findFile(query: string): Promise<string | { text: string; spoken: string }> {
  const found = await findMyFiles(query, picks());
  if (found.empty || !found.results.length) throw new Error("no files");
  const first = found.results[0];
  if (found.clear) {
    await fileOpen(first.path);
    remember(found.key, first.path);
    pending = null;
    return `Opening ${first.name}.`;
  }
  pending = { key: found.key, results: found.results.slice(0, 5), at: Date.now() };
  void emitTo("notch", "notch-files", { key: found.key, results: pending.results }).catch(() => {});
  const shown = Math.min(5, found.results.length);
  return { text: list(found.results, first.named), spoken: first.named ? `I found ${shown} that match. Which one?` : `Nothing's named that, but ${shown} files mention it. Which one?` };
}

/** "The second one" after a list: opens it and remembers the pick. */
export async function pickFile(n: number): Promise<string> {
  const chosen = pending?.results[n - 1];
  if (!pending || !chosen) throw new Error("no list");
  await fileOpen(chosen.path);
  remember(pending.key, chosen.path);
  pending = null;
  void emitTo("notch", "notch-files", null).catch(() => {});
  return `Opening ${chosen.name}.`;
}

/** A click on a result in the notch. */
export async function openPicked(key: string, path: string): Promise<void> {
  await fileOpen(path);
  remember(key, path);
  pending = null;
}
