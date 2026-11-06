import { toolBgRead, toolBgStart, toolBgStop, toolDiscardPreview, toolMakeDocument, toolReadDocument, type DocRead } from "../../lib/ipc";
import katex from "katex";
import type { ToolDefinition } from "./tools";

/**
 * The working tools Claude Code has that E.V's agents also need, whatever model runs them:
 * reading documents the way a person does (words + page pictures + words inside pictures), making
 * real PDF / Word documents and looking at the result, background commands, asking the user a
 * question with choices, and handing work to sub-agents.
 */

const DOCUMENT_EXTS = new Set(["pdf", "png", "jpg", "jpeg", "gif", "heic", "heif", "tif", "tiff", "bmp", "webp", "docx", "odt", "pptx", "xlsx", "pages", "key", "numbers", "doc", "rtf", "rtfd", "wordml", "webarchive"]);

/** Files read_file opens as documents (pages, pictures) rather than as plain text. */
export function isDocumentPath(path: string): boolean {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path.trim())?.[1]?.toLowerCase();
  return Boolean(ext && DOCUMENT_EXTS.has(ext));
}

const KIND_LABEL: Record<DocRead["kind"], string> = { pdf: "PDF", image: "Image", word: "Document", slides: "Slides", sheet: "Spreadsheet" };

/** Plain letters for PDF text: ligatures (ﬁ ﬃ) and math italics (𝑥) become ordinary characters. */
export const plainText = (text: string) => text.normalize("NFKC");

/** What the model gets from a document read: every page's words, then the attached pictures. */
export function formatDocument(raw: DocRead): { output: string; display: string; images: string[] } {
  const doc: DocRead = { ...raw, text: plainText(raw.text), pages: raw.pages.map((p) => ({ ...p, text: plainText(p.text), ocr: plainText(p.ocr) })) };
  const lines: string[] = [];
  const unit = doc.kind === "slides" ? "slide" : doc.kind === "sheet" ? "sheet" : "page";
  lines.push(`${doc.path} — ${KIND_LABEL[doc.kind]}${doc.kind === "image" ? "" : `, ${doc.pageCount} ${unit}${doc.pageCount === 1 ? "" : "s"}`}`);
  if (doc.text.trim()) lines.push(doc.text.trim());
  const images: string[] = [];
  const pictured: string[] = [];
  for (const page of doc.pages) {
    const label = page.number === 0 ? "Picture inside the file" : doc.kind === "image" ? "Image" : `${unit[0].toUpperCase()}${unit.slice(1)} ${page.number}`;
    const parts = [`--- ${label} ---`];
    if (page.text.trim()) parts.push(page.text.trim());
    if (page.ocr.trim()) parts.push(`[Words read from the ${page.number === 0 || doc.kind === "image" ? "picture" : "page's picture (screenshots, scans, diagrams)"}:]\n${page.ocr.trim()}`);
    if (!page.text.trim() && !page.ocr.trim()) parts.push("(no words found — look at the picture)");
    lines.push(parts.join("\n"));
    if (page.image) {
      images.push(page.image);
      pictured.push(label);
    }
  }
  if (pictured.length) lines.push(`Pictures attached, in order: ${pictured.join(", ")}. Graphs, tables, layout and handwriting are only fully visible in the pictures — look at them, don't rely on the words alone.`);
  if (doc.note) lines.push(doc.note);
  if (doc.kind === "pdf" && doc.pageCount > 6) lines.push("To condense, rewrite or summarize this into a new document: write it with document_part — one part per 3–4 pages of this source, in order — then make_document with from_parts=true.");
  const shown = doc.pages.filter((p) => p.number > 0);
  const range = shown.length && doc.kind !== "image" ? ` · ${unit}s ${shown[0].number}–${shown[shown.length - 1].number}` : "";
  return { output: lines.join("\n\n"), display: `${doc.path.split("/").pop()} · ${KIND_LABEL[doc.kind]}${doc.kind === "image" ? "" : ` · ${doc.pageCount} ${unit}${doc.pageCount === 1 ? "" : "s"}`}${range}`, images };
}

/**
 * A document's content keyed by page ("<path>#<page>"), so reading the same page twice doesn't
 * count it twice when a new document is compared with its source.
 */
export function pageBlocks(doc: DocRead): Record<string, string> {
  const out: Record<string, string> = {};
  if (doc.text.trim()) out[`${doc.path}#all`] = doc.text;
  for (const p of doc.pages) out[`${doc.path}#${p.number || `picture-${Object.keys(out).length}`}`] = plainText(`--- Page ${p.number} ---\n${p.text}\n${p.ocr}`);
  return out;
}

export async function readDocument(cwd: string, path: string, pages?: string): Promise<{ output: string; display: string; images: string[]; path: string; pageCount: number; pagesRead: number[]; blocks: Record<string, string> }> {
  const doc = await toolReadDocument(cwd, path, pages, true);
  const pagesRead = doc.kind === "pdf" ? doc.pages.map((p) => p.number).filter((n) => n > 0) : [];
  return { ...formatDocument(doc), path: doc.path, pageCount: doc.kind === "pdf" ? doc.pageCount : 0, pagesRead, blocks: pageBlocks(doc) };
}

/** Pages of each PDF read in this task, so a document made from a half-read source is caught. */
export type PagesRead = Record<string, { total: number; read: number[] }>;

/** "Final Cheat.pdf: pages 21–36" for every PDF read only in part. */
export function unreadPages(reads: PagesRead | undefined, request = ""): string[] {
  // Pages the user named ("pages 9–16", "page 4") are all that's needed; otherwise every page.
  const named = new Set<number>();
  for (const m of request.matchAll(/\bpages?\s+(\d+)(?:\s*(?:-|–|—|to|through)\s*(\d+))?/gi)) {
    const a = Number(m[1]);
    const b = Number(m[2] ?? m[1]);
    for (let n = Math.min(a, b); n <= Math.max(a, b) && n - Math.min(a, b) < 500; n++) named.add(n);
  }
  const out: string[] = [];
  for (const [path, { total, read }] of Object.entries(reads ?? {})) {
    const seen = new Set(read);
    const missing = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !seen.has(n) && (!named.size || named.has(n)));
    if (!missing.length) continue;
    const ranges: string[] = [];
    for (let i = 0; i < missing.length; i++) {
      const start = missing[i];
      while (i + 1 < missing.length && missing[i + 1] === missing[i] + 1) i++;
      ranges.push(start === missing[i] ? `${start}` : `${start}–${missing[i]}`);
    }
    out.push(`${path.split("/").pop()}: page${missing.length === 1 ? "" : "s"} ${ranges.join(", ")}`);
  }
  return out;
}

const FORMATS = ["pdf", "docx", "html", "rtf", "odt"];

const STOP = new Set("the and for with that this from into your you are was were have has had not but can will its their there them then than when what which who how why also each any all our out use using used make made more most some such only other over under very just like".split(" "));
/** Lines from lesson screenshots and web pages that are buttons, not content. */
const UI_NOISE = /^(click|next|back|submit|show my answer|try again|text description|type the correct|drag the|select all|watch this|let'?s|notice|consider|summary$|introduction$|explanation:?$)/i;
/** A line that ends mid-sentence ("…the mapping diagram of") or reads as an instruction isn't a heading. */
const ENDS_MIDWAY = /\b(of|the|a|an|to|in|and|or|can|is|are|for|with|as|by|that|this|these|its|their|be|from|on|at|if|when|which|it)$/i;
const NOT_A_HEADING = /^(keep|observe|notice|consider|look|use|select|type|recall|remember|here|in this|in the|the |this |these |it |we |you |let|first|then|now|next|so |for example|however|because|since|if |when |as |each |a |an )/i;

/** E.V's own labels in a document read (page markers, picture notes). */
const READER_NOTES = /^(---|\[Words read|Pictures attached|Pictures are attached|Read pages|\(no words found|Read from the file's)/;

const significant = (line: string) =>
  line
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STOP.has(w));

/**
 * Headings and short labelled lines in the source documents (the topics) that the new document
 * doesn't mention: a heading counts as kept when most of its words appear. Works the same for any
 * model — it's the harness checking, not the AI.
 */
export function missingTopics(sources: string[], made: string, limit = 25): string[] {
  const have = new Set(significant(made));
  // PDF text layers sometimes split words around letters ("q uartic"): compare without spaces too.
  const squashed = made.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const source of sources) {
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      // A line whose sentence carries on into the next one (lower-case start) is wrapped text, not a heading.
      if (/^[a-z(]/.test(lines[i + 1]?.trim() ?? "")) continue;
      if (READER_NOTES.test(lines[i].trim())) continue;
      // Titles of charts and data tables (bare numbers right around them) aren't topics.
      const near = [lines[i - 2], lines[i - 1], lines[i + 1], lines[i + 2]].map((l) => (l ?? "").trim());
      if (near.some((l) => /^[-−+$]?\d[\d.,%]*$/.test(l))) continue;
      const line = lines[i].replace(/^[-•*#\s\d.)]+/, "").replace(/[:.]+$/, "").trim();
      const words = line.split(/\s+/);
      // Topic-like: short, starts with a capital letter, not a sentence, not a page label or button.
      if (words.length < 2 || words.length > 7 || !/^[A-Z]/.test(line) || /[.?!,;]\s|[,;]$/.test(line) || /^(Page|Picture|Pictures|Slide|Image) \d/.test(line) || UI_NOISE.test(line) || ENDS_MIDWAY.test(line) || NOT_A_HEADING.test(line)) continue;
      // Headings are title-style: every longer word capitalized ("Interval Notation", "Domain and Range").
      if (words.some((w) => /^[a-z]{4,}/.test(w))) continue;
      const key = significant(line);
      if (key.length < 2 || seen.has(key.join(" "))) continue;
      seen.add(key.join(" "));
      const kept = key.filter((w) => have.has(w) || have.has(w.replace(/s$/, "")) || have.has(`${w}s`) || squashed.includes(w.replace(/s$/, ""))).length;
      if (kept / key.length < 0.6) missing.push(line);
      if (missing.length >= limit) return missing;
    }
  }
  return missing;
}

/**
 * Makes the document, then reads its pages back as pictures so the AI checks its own work before
 * telling the user it's done — the step that stops "done" from meaning "a file exists".
 */
/**
 * Typesets LaTeX written between \( \), \[ \] or $$ $$ as MathML, which the browser draws
 * natively — no fonts or scripts to load, so it works in the offline document renderer. Single $
 * is left alone (prices). Script and style blocks are untouched.
 */
export function typesetMath(html: string): string {
  const render = (tex: string, display: boolean) => {
    try {
      // The TeX source KaTeX keeps in a hidden <annotation> isn't needed in a printed document.
      return katex.renderToString(tex.trim(), { output: "mathml", displayMode: display, throwOnError: false, strict: "ignore" }).replace(/<annotation[^>]*>[\s\S]*?<\/annotation>/g, "");
    } catch {
      return tex;
    }
  };
  return html
    .split(/(<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>)/i)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => render(decode(tex), true))
            .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex: string) => render(decode(tex), true))
            .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex: string) => render(decode(tex), false))
            .replace(SINGLE_DOLLAR, (whole, tex: string) => (looksLikeMath(tex) ? render(decode(tex), false) : whole)),
    )
    .join("");
}

/** $…$ on one line: starts and ends next to a non-space, not followed by a digit (so "$5 and $6" stays text). */
const SINGLE_DOLLAR = /(?<![\\$\w])\$(?!\s)((?:(?!<[a-zA-Z/!])[^$\n]){1,300}?)(?<!\s)\$(?![\d$])/g;

/** Text between single dollars that is math, not money: LaTeX commands, ^ _ = {}, or a lone variable. */
export function looksLikeMath(tex: string): boolean {
  if (/^\d[\d,]*(\.\d+)?$/.test(tex.trim())) return false;
  const t = tex.trim();
  // Comparisons and arithmetic with a variable ("k > 0", "x + 2") are math too.
  return /\\[a-zA-Z]+|[\^_={}]|^[a-zA-Z]$|^[a-zA-Z]\([a-z]\)$|^[a-zA-Z](\s*,\s*[a-zA-Z])+$/.test(t) || (/[a-zA-Z]/.test(t) && /[<>≤≥+\-*/]|&[lg]t;/.test(t) && !/\b[a-z]{4,}\b/i.test(t));
}

/** Math code left in a finished document's text (typesetting failed or wasn't asked for). */
export function rawMathLeft(text: string): string[] {
  const found = text.match(/\\(frac|sqrt|ge|le|geq|leq|neq|pm|cdot|infty|implies|times|div|alpha|beta|theta|pi|text|left|right|circ|in|mathbb)\b|\$[^$\n]{1,40}\$/g) ?? [];
  return [...new Set(found)].slice(0, 5);
}

/** LaTeX inside HTML may have its <, > and & escaped. */
const decode = (tex: string) => tex.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/<br\s*\/?>/gi, " ");

/** The user asked for every detail to be kept (so a much shorter result is a problem, not a summary). */
export const KEEP_DETAILS = /(don'?t|do not|without|not)\s+(lose|losing|lost|remove|removing|drop|dropping|cut|cutting|delete|deleting|miss|missing|skip|skipping)|all (of )?(the )?(details|content|info)|every (detail|thing|example|definition|rule|formula|topic)|keep (everything|all)|full[- ]detail|nothing (missing|left out)/i;

/** The user said to leave examples out (a common rule for allowed test notes). */
export const NO_EXAMPLES = /\bno examples?\b|without (any )?examples?|(don'?t|do not|never) (include|add|put|use|have|give)( any)? examples?|examples? (are|is) not allowed|(can'?t|cannot|can not) have( any)? examples?/i;
const EXAMPLE_WORDS = /\b(examples?|for instance|sample problem|worked problem)\b|\be\.g\./i;

const wordCount = (text: string) => text.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length;

/** Words of real content in a document read (E.V's own labels left out). */
function sourceWords(sources: string[]): number {
  return wordCount(sources.join("\n").split("\n").filter((l) => !READER_NOTES.test(l.trim())).join("\n"));
}

/**
 * Checks the harness makes on every document, whatever model wrote it: empty space on its pages,
 * and — when it was made from documents read in this task — how much of their content it kept.
 */
export function documentChecks(preview: DocRead, madeText: string, sources: string[], request: string, smallText = 0): { notes: string[]; problems: string[] } {
  const notes: string[] = [];
  const problems: string[] = [];
  // Empty space only matters when something is missing (or tiny text) — short content may just be short.
  const blankPages = preview.pages.filter((p) => (p.number < preview.pages.length && p.blank > 0.25) || (preview.pages.length === 1 && p.blank > 0.35));
  const blankNote = blankPages.length
    ? `Empty space: ${blankPages.map((p) => `page ${p.number} is ${Math.round(p.blank * 100)}% empty at the bottom`).join(", ")} — use it for any content that's missing.`
    : "";
  if (smallText > 0.2) {
    if (blankNote) notes.push(blankNote);
    const pct = Math.round(smallText * 100);
    notes.push(`${pct}% of the text is under 7pt — too small to read on paper. Use at least 7.5pt for body text and add pages or columns instead of shrinking.`);
    problems.push(`${pct}% of the text is too small to read when printed`);
  }
  if (NO_EXAMPLES.test(request)) {
    const found = EXAMPLE_WORDS.exec(madeText);
    if (found) {
      const at = madeText.indexOf(found[0]);
      const context = madeText.slice(Math.max(0, at - 60), at + 80).replace(/\s+/g, " ").trim();
      notes.push(`The user said no examples, but the document still has “${found[0]}” (…${context}…). Remove examples entirely; a fact like "all linear functions are one-to-one" is fine as a rule — just don't label or phrase it as an example.`);
      problems.push(`the user said no examples, but it has “${found[0]}”`);
    }
  }
  if (sources.length) {
    const src = sourceWords(sources);
    const out = wordCount(madeText);
    const share = src ? Math.round((out / src) * 100) : 100;
    if (src > 200) {
      const keepAll = KEEP_DETAILS.test(request);
      if (keepAll && share < 20) {
        problems.push(`only ${share}% of the source's content is in it, but the user asked to keep the details`);
        if (blankNote) notes.push(blankNote);
      }
      notes.push(
        `Size check: your document has about ${out.toLocaleString()} words; the source document(s) you read have about ${src.toLocaleString()} (you kept ${share}%).${
          keepAll && share < 20
            ? ` The user asked to keep the details. A condensed version that keeps every definition, rule, worked example and table usually keeps at least a fifth to a third of the words (about ${Math.round(src / 5).toLocaleString()}+ here) — so content is missing. Don't rewrite it all in one go: build it with document_part, one part per 3–4 pages of the source (each part keeps everything from those pages, about ${Math.max(200, Math.round(src / 4 / Math.max(1, Math.ceil(src / 900)))).toLocaleString()} words), then make_document with from_parts=true.`
            : ""
        }`,
      );
    }
  }
  return { notes, problems };
}

export interface MadeResult {
  output: string;
  display: string;
  images: string[];
  ok: boolean;
  /** Absolute path written. */
  path?: string;
  /** What still fails E.V's checks (the AI isn't allowed to finish on these). */
  problems: string[];
}

/**
 * Print layout for documents built from parts: dense, readable two columns. Models that write a
 * full page of HTML in one go tend to shrink everything; parts + this layout keep type readable.
 */
export const PARTS_CSS = `@page { size: letter; margin: 0.4in; }
* { box-sizing: border-box; }
body { font: 8.5pt/1.3 "Helvetica Neue", Arial, sans-serif; color: #111; margin: 0; }
h1 { font-size: 13pt; margin: 0 0 4pt; text-align: center; }
.cols { column-count: 2; column-gap: 0.22in; column-rule: 0.5pt solid #bbb; }
h2 { font-size: 9.6pt; margin: 6pt 0 2pt; padding: 1pt 4pt; background: #e6eef7; border-left: 3pt solid #2a5d9f; break-after: avoid; }
h3 { font-size: 8.8pt; margin: 4pt 0 1pt; color: #2a5d9f; break-after: avoid; }
p { margin: 1pt 0 3pt; }
ul, ol { margin: 1pt 0 3pt; padding-left: 12pt; }
li { margin: 0.5pt 0; }
table { border-collapse: collapse; width: 100%; margin: 2pt 0 4pt; font-size: 8pt; break-inside: avoid; }
td, th { border: 0.5pt solid #999; padding: 1pt 3pt; }
th { background: #eee; }
.box, blockquote { border: 0.8pt solid #2a5d9f; padding: 2pt 5pt; margin: 3pt 0; break-inside: avoid; }
img { max-width: 100%; }
section { break-inside: auto; }`;

/** Puts the parts written with document_part into one document with PARTS_CSS. */
export function assembleParts(parts: string[], title: string, css = ""): string {
  const body = parts.map((p) => `<section>${p}</section>`).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, "&lt;")}</title><style>${PARTS_CSS}\n${css}</style></head><body>${title ? `<h1>${title.replace(/</g, "&lt;")}</h1>` : ""}<div class="cols">${body}</div></body></html>`;
}

/** Words in a piece of HTML (tags left out). */
export const htmlWords = (html: string) => wordCount(html.replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, " "));

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, single: 1 };

/** The page count the user asked for ("a 2-page PDF", "two pages", "one page"), if any. */
export function wantedPageCount(request: string): number | null {
  const m = /\b(\d{1,2}|one|two|three|four|five|six|single)[- ]?(?:page|pages|pg)\b(?!\s*(?:\d|of\b))/i.exec(request);
  if (!m) return null;
  const n = NUMBER_WORDS[m[1].toLowerCase()] ?? Number(m[1]);
  return n >= 1 && n <= 50 ? n : null;
}

/** The document scaled down (CSS zoom), to fit a page count. */
export const scaled = (html: string, zoom: number) => {
  const rule = `<style>html{zoom:${zoom}}</style>`;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${rule}</head>`) : `${rule}${html}`;
};

export async function makeDocument(cwd: string, args: Record<string, unknown>, request: string, sources: string[] = [], attempt = 1, unread: string[] = [], parts: string[] = [], gaps: number[] = []): Promise<MadeResult> {
  const path = String(args.path ?? "").trim();
  const format = String(args.format ?? (/\.([a-z]+)$/i.exec(path)?.[1] ?? "pdf")).toLowerCase();
  // Parts written for this document and no HTML given: the parts are clearly what's meant.
  const fromParts = args.from_parts === true || (parts.length > 0 && String(args.html ?? "").trim().length < 20);
  if (fromParts && !parts.length) return { output: "Error: there are no parts for this document yet — write them with document_part first.", display: "No parts yet", images: [], ok: false, problems: [] };
  const html = fromParts ? assembleParts(parts, String(args.title ?? ""), String(args.css ?? "")) : String(args.html ?? "");
  if (!path) return { output: "Error: give a path for the document.", display: "No path", images: [], ok: false, problems: [] };
  if (!FORMATS.includes(format)) return { output: `Error: format must be one of ${FORMATS.join(", ")}.`, display: "Unknown format", images: [], ok: false, problems: [] };
  if (html.trim().length < 20) return { output: "Error: html is empty — pass the complete HTML of the document, or write it in parts with document_part and set from_parts.", display: "Empty document", images: [], ok: false, problems: [] };
  const paper = typeof args.paper === "string" ? args.paper : undefined;
  const typeset = typesetMath(html);
  let made = await toolMakeDocument(cwd, path, format, typeset, args.landscape === true, paper);
  // The user asked for N pages and it came out a page or two over: E.V fits it by scaling the
  // layout down in small steps (never below readable type) — like "fit to pages" when printing.
  const target = Number(args.pages) || wantedPageCount(request);
  let fitted = "";
  if (target && format === "pdf") {
    let count = (await toolReadDocument(cwd, made.previewPdf, "1", false).catch(() => null))?.pageCount ?? 0;
    for (const zoom of [0.95, 0.9, 0.85, 0.8, 0.75]) {
      if (count <= target || count > target + 2) break;
      const attempt = await toolMakeDocument(cwd, path, format, scaled(typeset, zoom), args.landscape === true, paper);
      const pages = (await toolReadDocument(cwd, attempt.previewPdf, "1", false).catch(() => null))?.pageCount ?? count;
      if (attempt.smallText > 0.2) {
        void toolDiscardPreview(attempt.previewPdf).catch(() => {});
        // Too small to read: put back the last readable version.
        made = await toolMakeDocument(cwd, path, format, fitted ? scaled(typeset, Number(fitted)) : typeset, args.landscape === true, paper);
        break;
      }
      void toolDiscardPreview(made.previewPdf).catch(() => {});
      made = attempt;
      fitted = String(zoom);
      count = pages;
    }
  }
  try {
    const preview = await toolReadDocument(cwd, made.previewPdf, undefined, true);
    const images = preview.pages.map((p) => p.image).filter(Boolean);
    const size = made.bytes > 1_000_000 ? `${(made.bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(made.bytes / 1000))} KB`;
    const pages = preview.pageCount;
    const words = plainText([preview.text, ...preview.pages.map((p) => `${p.text}\n${p.ocr}`)].join("\n"));
    const missing = sources.length ? missingTopics(sources, words) : [];
    const checks = documentChecks(preview, words, sources, request, made.smallText);
    if (made.overflow?.length) {
      checks.notes.push(`Text spills out of its box or table cell and prints over the next column: ${made.overflow.map((t) => `“${t}”`).join(", ")}. Let long formulas wrap (shorter lines, a wider column, or a line break) instead.`);
      checks.problems.push(`text spills out of ${made.overflow.length} table cell(s)/box(es)`);
    }
    const leftover = rawMathLeft(words);
    if (leftover.length) checks.notes.push(`Math code is showing as text in the document (${leftover.join(", ")}). Write math as LaTeX inside \\( \\) or \\[ \\] so E.V typesets it.`);
    // Only a problem when the whole document was the source (a page range the user named is fine).
    const unreadProblem = unread.length && KEEP_DETAILS.test(request) ? [`parts of the source were never read (${unread.join("; ")}) — read them with read_file and add what's on them`] : [];
    const gapProblem = fromParts && gaps.length ? [`source pages ${gaps[0]}–${gaps[gaps.length - 1]} have no section yet — condense_document with pages="${gaps[0]}-${gaps[gaps.length - 1]}", or document_part`] : [];
    // Keeping details was asked for: three missing topics already block finishing (otherwise five).
    const topicLimit = KEEP_DETAILS.test(request) ? 3 : 5;
    const problems = [...gapProblem, ...unreadProblem, ...(leftover.length ? [`math shows as code (${leftover.join(", ")})`] : []), ...checks.problems, ...(missing.length >= topicLimit ? [`${missing.length} topics from the source are missing (${missing.slice(0, 6).join("; ")}…)`] : [])];
    if (target && pages > target) checks.notes.push(`It's ${pages} pages; the user asked for ${target}. E.V couldn't fit it by scaling without making the type too small — cut repetition or tighten the layout, but keep the content.`);
    const output = [
      `Saved ${made.path} (${format.toUpperCase()}, ${pages} page${pages === 1 ? "" : "s"}, ${size}).${fitted ? ` E.V scaled it to ${Math.round(Number(fitted) * 100)}% to fit the ${target} page${target === 1 ? "" : "s"} asked for — don't change the layout to fit it yourself.` : target && pages <= target ? ` That's within the ${target} page${target === 1 ? "" : "s"} asked for.` : ""}`,
      format === "docx" || format === "rtf" || format === "odt" ? "The pictures show the HTML layout; Word may differ slightly (columns and some CSS don't carry over to Word)." : "",
      `Pictures of ${images.length < pages ? `the first ${images.length} pages` : "every page"} are attached. CHECK YOUR WORK before you tell the user it's done:`,
      `1. Compare against the request: "${request.slice(0, 600)}". Is everything they asked for there?`,
      "2. If you made it from another document or notes, is every fact, formula, example and table from the source still in it? Shorter must mean tighter layout, not lost content.",
      "3. Look for text cut off at page edges, overlapping, text too small to read when printed (under ~7.5pt), empty pages, broken images, or a page count far from what was asked.",
      missing.length
        ? `E.V compared this document with the source document(s) you read in this task. These headings/topics from the source don't appear in it:\n${missing.map((m) => `  - ${m}`).join("\n")}\nEach one is probably a dropped section: put its content back (use more pages or columns if needed — never drop content to hit a page count). Ignore any that are only buttons, captions from screenshots${NO_EXAMPLES.test(request) ? ", or titles of examples (the user said no examples)" : ""}.`
        : sources.length
          ? "E.V compared this document with the source document(s) you read: every heading/topic from them appears in it."
          : "",
      ...checks.notes,
      problems.length
        ? `E.V's checks FAILED: ${problems.join("; ")}. Fix these and make it again.`
        : attempt >= 3
          ? `All of E.V's checks passed and this is version ${attempt}. Stop remaking it — reply to the user now unless something is clearly wrong in the pictures.`
          : "All of E.V's checks passed. If the pictures show nothing wrong, reply to the user; otherwise fix the HTML and make it again.",
    ]
      .filter(Boolean)
      .join("\n");
    return { output, display: `${made.path.split("/").pop()} · ${pages} page${pages === 1 ? "" : "s"} · ${size}`, images, ok: true, path: made.path, problems };
  } finally {
    void toolDiscardPreview(made.previewPdf).catch(() => {});
  }
}

export async function startBackground(cwd: string, command: string): Promise<{ output: string; display: string; ok: boolean }> {
  const id = await toolBgStart(cwd, command);
  // A short first look catches commands that fail straight away (missing script, port in use).
  const first = await toolBgRead(id, 3);
  const status = first.running ? "still running" : `already exited with code ${first.exitCode ?? "?"}`;
  return {
    output: `Started in the background as ${id} (${status}).\n${first.output ? `First output:\n${first.output}` : "(no output yet)"}\nRead more with command_output (id ${id}); stop it with command_stop when you're done with it.`,
    display: `${id} · ${status}`,
    ok: first.running || first.exitCode === 0,
  };
}

export async function backgroundOutput(id: string, wait?: number): Promise<{ output: string; display: string; ok: boolean }> {
  const s = await toolBgRead(id, wait);
  const state = s.running ? `running for ${s.seconds}s` : `finished (exit code ${s.exitCode ?? "?"})`;
  const skipped = s.skipped ? `[${s.skipped.toLocaleString()} characters of older output were dropped]\n` : "";
  return { output: `${id} — $ ${s.command} — ${state}\n${skipped}${s.output || "(no new output)"}`, display: `${id} · ${state}`, ok: s.running || s.exitCode === 0 };
}

export async function stopBackground(id: string): Promise<{ output: string; display: string; ok: boolean }> {
  const s = await toolBgStop(id);
  return { output: `Stopped ${id} ($ ${s.command}).${s.output ? `\nLast output:\n${s.output}` : ""}`, display: `Stopped ${id}`, ok: true };
}

/** Claude's document skills (pypdf, reportlab, python-docx scripts) — E.V has its own tools for these. */
export const REPLACED_SKILLS = new Set(["pdf", "docx", "pptx", "xlsx"]);
export const REPLACED_SKILL_NOTE =
  "E.V reads PDFs, images, Word, PowerPoint and Excel files with read_file and makes PDF and Word documents with make_document — use those, not this skill's scripts.";

const DOC_LIBRARIES =
  /\b(pypdf2?|pdfplumber|fitz|pymupdf|pdfminer|pdftotext|pdftoppm|pdfimages|tesseract|textutil|docx2txt|python-docx|openpyxl|python-pptx|reportlab|fpdf2?|weasyprint|wkhtmltopdf|pandoc|img2pdf)\b|\b(from|import) (docx|pptx|PyPDF2|pypdf|reportlab|fitz)\b/i;

/**
 * A command that reads or makes documents with scripts instead of E.V's own tools (which read
 * words inside pictures and check the result). Allowed when the user named that tool themselves.
 */
export function documentScript(command: string, request: string): string | null {
  const match = DOC_LIBRARIES.exec(command);
  const found = match?.[1] ?? match?.[3];
  if (!found) return null;
  return new RegExp(`\\b${found.replace(/\W/g, "\\$&")}\\b`, "i").test(request) ? null : found;
}

export const ASK_TOOL = "ask_user";
export const AGENT_TOOL = "agent";

export const WORK_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "document_part",
    description:
      "Write one section of a long document (HTML fragment: <h2>, <p>, <ul>, <table>…, no <html>/<style>). Use it for anything longer than about a page — condensing notes or a long PDF, reports — one call per section or per 3–4 source pages, in order, keeping every detail of that part. Then call make_document with from_parts=true: E.V puts the parts together in a readable two-column print layout. replace=N rewrites part N instead of adding one.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The document these parts are for (same path you'll give make_document)" },
        html: { type: "string", description: "This section's HTML fragment" },
        replace: { type: "integer", description: "Rewrite part number N (1-based) instead of adding a new part" },
      },
      required: ["path", "html"],
    },
  },
  {
    name: "make_document",
    description:
      "Make a real document file — PDF, Word (docx), RTF, ODT or HTML — from complete HTML you write (use CSS for layout: columns, tables, @page size/margins, font sizes). For PDFs this is the right tool, not scripts. Anything longer than about a page: write it with document_part first, then set from_parts=true here. Images: reference local files by path relative to the document's folder; web links don't load. After saving, you get a picture of every page and a check against any source documents you read; fix and remake it if anything is wrong. When condensing notes, keep every topic, rule, formula and worked example — use as many pages as that takes (dense two-column pages are usually a fifth to a third of the original); never squeeze content out to fit one page. Math: write LaTeX inside \\( \\) inline or \\[ \\] on its own line — E.V typesets it; don't put raw LaTeX in <code>.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Where to save it, e.g. '~/Desktop/Unit 5 notes.pdf'" },
        format: { type: "string", description: "pdf (default), docx, html, rtf or odt", enum: FORMATS },
        html: { type: "string", description: "The complete HTML document (<!doctype html> … </html>) with its CSS inside <style> — or leave it out and set from_parts" },
        from_parts: { type: "boolean", description: "Build it from the parts written with document_part (E.V's two-column print layout)" },
        title: { type: "string", description: "With from_parts: the heading at the top" },
        css: { type: "string", description: "With from_parts: extra CSS (optional)" },
        paper: { type: "string", description: "letter (default), a4, legal or tabloid" },
        landscape: { type: "boolean", description: "Landscape pages" },
        pages: { type: "integer", description: "Page count the user asked for — E.V scales the layout to fit it (you don't have to)" },
      },
      required: ["path"],
    },
  },
  {
    name: "command_output",
    description: "Read new output from a command started with run_command background=true, and whether it's still running. wait_seconds waits for more output or for it to finish (max 120).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The id run_command returned, e.g. 'bg1'" },
        wait_seconds: { type: "integer", description: "Wait up to this long for new output (default 0)" },
      },
      required: ["id"],
    },
  },
  {
    name: "command_stop",
    description: "Stop a background command (and everything it started).",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "The id run_command returned" } },
      required: ["id"],
    },
  },
  {
    name: ASK_TOOL,
    description:
      "Ask the user a question with clickable choices when you're blocked on a decision only they can make (which of two files, which approach, which person). Don't ask what you can find out yourself or what has an obvious default. Put the option you recommend first and add ' (Recommended)' to it. The user can also type their own answer.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, ending with ?" },
        options: {
          type: "array",
          description: "2–4 choices",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Short choice (1–5 words)" },
              description: { type: "string", description: "What choosing it means" },
            },
            required: ["label"],
          },
        },
        multi_select: { type: "boolean", description: "Allow picking more than one" },
      },
      required: ["question", "options"],
    },
  },
  {
    name: AGENT_TOOL,
    description: [
      "Hand a self-contained piece of work to a sub-agent that runs on its own with your model and returns a report — like a colleague you brief. Several agent calls in one reply run at the same time.",
      "Use it to: search a big codebase or many files (type 'explore'), research a topic across many pages (type 'research'), or read and summarize a long document while you keep your context clear.",
      "Sub-agents can look things up, read files and documents, search, browse and run look-only commands — they can't change files, send messages or control apps (anything needing approval stays with you).",
      "The sub-agent can't see this conversation: brief it fully — the goal, what's known, file paths, and exactly what to report back.",
      "Don't use it for one quick lookup you can do in one or two steps yourself.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "3–6 word name for the job, e.g. 'Find where approvals are decided'" },
        prompt: { type: "string", description: "The full briefing: goal, context, where to look, what to report" },
        type: { type: "string", description: "explore (files and code), research (web), or general", enum: ["explore", "research", "general"] },
      },
      required: ["description", "prompt"],
    },
  },
];

export interface Question {
  question: string;
  options: { label: string; description?: string }[];
  multi: boolean;
}

export function parseQuestion(args: Record<string, unknown>): Question | null {
  const question = String(args.question ?? "").trim();
  const raw = Array.isArray(args.options) ? args.options : [];
  const options = raw
    .map((o) => {
      if (typeof o === "string") return { label: o.trim() };
      const rec = (o ?? {}) as Record<string, unknown>;
      return { label: String(rec.label ?? "").trim(), description: rec.description ? String(rec.description).trim() : undefined };
    })
    .filter((o) => o.label)
    .slice(0, 6);
  if (!question || options.length < 2) return null;
  return { question, options, multi: args.multi_select === true };
}
