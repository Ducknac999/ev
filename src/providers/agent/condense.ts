import { toolReadDocument, type DocRead } from "../../lib/ipc";
import type { AgentAdapter } from "./adapters";
import type { ToolDefinition } from "./tools";
import { formatDocument, htmlWords, pageBlocks } from "./workTools";

/**
 * condense_document: E.V itself splits a long source into small page groups and has the model
 * rewrite each group on its own, at the same time. Asked for a whole document in one go, models
 * (small ones especially) write a page of bullets whatever they're told; asked for three pages at
 * a time with one narrow job, they keep the details. The parts go into the document's draft, and
 * make_document with from_parts=true lays them out.
 */

export const CONDENSE_TOOL = "condense_document";
export const PAGES_PER_PART = 3;
export const CONDENSE_LANES = 8;

export const CONDENSE_TOOL_DEFINITION: ToolDefinition = {
  name: CONDENSE_TOOL,
  description:
    "Condense a long PDF (notes, slides, a report) into the parts of a new document — E.V reads it a few pages at a time and rewrites every page group in detail, in parallel. Use it whenever the user wants a long document made shorter, easier to print, or turned into notes/a cheat sheet. Then call make_document with from_parts=true (same path) and a title. Pass the user's wishes in instructions (e.g. 'leave out examples', 'keep every worked example').",
  parameters: {
    type: "object",
    properties: {
      source: { type: "string", description: "The PDF to condense" },
      path: { type: "string", description: "The new document these parts are for (the path you'll give make_document)" },
      instructions: { type: "string", description: "What the user wants kept, left out, or emphasized" },
      pages: { type: "string", description: "Only these pages, e.g. '9-16' (default: all)" },
    },
    required: ["source", "path"],
  },
};

const SYSTEM = [
  "You turn a few pages of study notes or a document into one section of a condensed, printable reference sheet, written as an HTML fragment.",
  "Keep EVERYTHING that matters on these pages: every definition, rule, property, formula, step list, table and key fact — and every worked example unless the instructions say to leave examples out. Condensing means tighter wording and no repetition, never dropping content.",
  "Other page groups of the same document are condensed separately: if these pages only repeat something (a second copy of a table, a lesson summary that restates the lesson), keep it once, in its most complete form.",
  "Leave out only: lesson navigation and buttons ('Click each thumbnail', 'Next', 'Submit'), stock photos, and sentences that only introduce or repeat something.",
  "Words in [Words read from the page's picture] come from screenshots on the page — they're real content. Look at the page pictures for tables, graphs and math.",
  "Format: <h2> for each topic, then <p>, <ul>/<li>, <table> (small tables of values or rules), <b> for key terms. Math as LaTeX inside \\( \\) or \\[ \\]. No <html>, <head>, <style> or <body>, no markdown, no commentary — reply with only the HTML.",
  "Length: aim for about 40% of the words on these pages — dense, but nothing important missing.",
].join("\n");

const REVIEW = [
  "You check one section of a condensed reference sheet against the source pages it was made from.",
  "Go through the pages item by item: every definition, rule, property (e.g. 'second differences are constant'), formula, step list, table, key fact — and worked example unless the user's wishes say to leave examples out. Note anything missing from the section or stated wrongly.",
  "If something is missing or wrong, reply with the complete corrected section as an HTML fragment (same format: <h2>, <p>, <ul>, <table>, math as LaTeX in \\( \\)). If nothing is missing, reply with exactly: OK",
].join("\n");

export function pageGroups(pages: number[], size = PAGES_PER_PART): number[][] {
  const groups: number[][] = [];
  for (let i = 0; i < pages.length; i += size) groups.push(pages.slice(i, i + size));
  return groups;
}

/** "9-16" or "1,3,5-7" → page numbers within 1…count; empty → every page. */
export function wantedPages(spec: string | undefined, count: number): number[] {
  if (!spec?.trim()) return Array.from({ length: count }, (_, i) => i + 1);
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const [a, b] = part.split(/[-–]/).map((x) => Number(x.trim()));
    if (!a) continue;
    for (let n = a; n <= (b || a) && n <= count; n++) if (n >= 1) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}

/** The model's reply as a clean HTML fragment (code fences and stray document tags removed). */
export function cleanFragment(text: string): string {
  return text
    .replace(/^```(?:html)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .replace(/<\/?(html|head|body)[^>]*>|<!doctype[^>]*>|<style[\s\S]*?<\/style>/gi, "")
    .trim();
}

export interface CondenseDeps {
  adapter: AgentAdapter;
  model: string;
  cwd: string;
  /** One model request on a key; each lane gets a key of its own where one is free. */
  runModel: <T>(lane: string, run: (key: string) => Promise<{ value: T; headers: Record<string, string> }>) => Promise<T>;
  signal: AbortSignal;
  onProgress: (done: number, total: number, note: string) => void;
}

export async function condenseDocument(args: Record<string, unknown>, deps: CondenseDeps): Promise<{ parts: string[]; firstPages: number[]; gaps?: number[][]; output: string; display: string; ok: boolean; sourcePages: Record<string, string>; pages: number[] }> {
  const source = String(args.source ?? "").trim();
  const instructions = String(args.instructions ?? "").trim();
  const head = await toolReadDocument(deps.cwd, source, "1", false);
  if (head.kind !== "pdf") return { parts: [], output: "condense_document works on PDFs. For other files, read them with read_file and write the parts with document_part.", display: "Not a PDF", ok: false, sourcePages: {}, pages: [], firstPages: [] };
  const groups = pageGroups(wantedPages(typeof args.pages === "string" ? args.pages : undefined, head.pageCount));
  if (!groups.length) return { parts: [], output: `No pages to condense (the PDF has ${head.pageCount}).`, display: "No pages", ok: false, sourcePages: {}, pages: [], firstPages: [] };

  const parts: string[] = new Array(groups.length).fill("");
  let sourcePages: Record<string, string> = {};
  let finished = 0;
  deps.onProgress(0, groups.length, "Reading the source…");

  const runGroup = async (index: number, lane: string) => {
    const group = groups[index];
    const range = group.length > 1 ? `${group[0]}-${group[group.length - 1]}` : `${group[0]}`;
    const doc: DocRead = await toolReadDocument(deps.cwd, source, range, deps.adapter.provider === "gemini");
    const words = formatDocument(doc);
    sourcePages = { ...sourcePages, ...pageBlocks(doc) };
    const task = `${instructions ? `The user's wishes: ${instructions}\n\n` : ""}Pages ${range.replace("-", "–")} of ${head.pageCount}:\n\n${words.output}`;
    const conversation =
      deps.adapter.provider === "gemini"
        ? [{ role: "user", parts: [{ text: task }, ...words.images.flatMap((data, i) => [{ text: `Picture of page ${group[i]}:` }, { inlineData: { mimeType: "image/jpeg", data } }])] }]
        : [{ role: "user", content: task }];
    let text = "";
    await deps.runModel(lane, async (key) => {
      text = "";
      const out = await deps.adapter.step({ model: deps.model, key, system: SYSTEM, conversation, tools: [], signal: deps.signal, onText: (d) => void (text += d) });
      return { value: out, headers: out.headers };
    });
    const draft = cleanFragment(text);
    // Check the section against its pages and fix it — a second, narrow look catches what the first dropped.
    let reviewed = "";
    try {
      const review =
        deps.adapter.provider === "gemini"
          ? [{ role: "user", parts: [{ text: `${task}\n\n=== The section written from these pages ===\n${draft}` }, ...((conversation[0] as { parts: unknown[] }).parts.slice(1) as object[])] }]
          : [{ role: "user", content: `${task}\n\n=== The section written from these pages ===\n${draft}` }];
      await deps.runModel(lane, async (key) => {
        reviewed = "";
        const out = await deps.adapter.step({ model: deps.model, key, system: REVIEW, conversation: review, tools: [], signal: deps.signal, onText: (d) => void (reviewed += d) });
        return { value: out, headers: out.headers };
      });
    } catch (err) {
      if (deps.signal.aborted) throw err;
      reviewed = "";
    }
    const fixed = cleanFragment(reviewed);
    parts[index] = /^ok\.?$/i.test(fixed) || !/<[a-z]/i.test(fixed) || htmlWords(fixed) < htmlWords(draft) * 0.8 ? draft : fixed;
    finished++;
    deps.onProgress(finished, groups.length, `Pages ${range.replace("-", "–")} · ${htmlWords(parts[index])} words`);
  };

  // A few page groups at a time, each on its own key lane.
  let next = 0;
  const failures: number[][] = [];
  const failureReasons: string[] = [];
  await Promise.all(
    Array.from({ length: Math.min(CONDENSE_LANES, groups.length) }, async (_, lane) => {
      while (next < groups.length) {
        const index = next++;
        if (deps.signal.aborted) return;
        // Busy keys and short outages are common with many requests at once: retry with waits.
        for (let attempt = 1; ; attempt++) {
          try {
            await runGroup(index, `condense-${lane + 1}`);
            break;
          } catch (err) {
            if (deps.signal.aborted) return;
            if (attempt >= 6) {
              failures.push(groups[index]);
              failureReasons.push(err instanceof Error ? err.message : String(err));
              break;
            }
            // Wait as long as the key pool says the next key needs, or back off.
            const wait = Number(/frees up in (\d+)s/.exec(err instanceof Error ? err.message : String(err))?.[1]);
            await new Promise((resolve) => setTimeout(resolve, (wait ? wait + 1 : 4 * attempt) * 1000));
          }
        }
      }
    }),
  );
  if (deps.signal.aborted) throw new Error("stopped");
  const kept = parts.filter(Boolean);
  const firstPages = groups.filter((_, i) => parts[i]).map((g) => g[0]);
  const words = kept.map(htmlWords).reduce((a, b) => a + b, 0);
  return {
    parts: kept,
    firstPages,
    gaps: failures.map((g) => g),
    sourcePages,
    pages: groups.filter((_, i) => parts[i]).flat(),
    ok: kept.length > 0,
    display: `${kept.length} parts · ${words.toLocaleString()} words from ${groups.length * PAGES_PER_PART >= head.pageCount ? `all ${head.pageCount} pages` : `${groups.flat().length} pages`}`,
    output: [
      `Condensed ${groups.flat().length} pages of ${source.split("/").pop()} into ${kept.length} parts (${words.toLocaleString()} words) for ${String(args.path)}.`,
      failures.length ? `Couldn't condense ${failures.map((g) => `pages ${g[0]}–${g[g.length - 1]}`).join("; ")} (${failureReasons[0]}) — call condense_document again with pages set to those, or read them and add them with document_part.` : "",
      "Next: call make_document with from_parts=true, the same path, and a title. If a part needs changes, use document_part with replace=N first.",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}
