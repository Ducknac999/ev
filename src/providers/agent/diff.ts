import type { DiffLine } from "../../types";

const CONTEXT = 3;
const MAX_LINES = 400;
/** Above this many changed lines the LCS table gets expensive; fall back to delete-all/add-all. */
const MAX_LCS_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Edit script for the differing middle of two files (common prefix/suffix already removed). */
function middleDiff(a: string[], b: string[]): ("eq" | "del" | "add")[] {
  if (a.length * b.length > MAX_LCS_CELLS) {
    return [...a.map(() => "del" as const), ...b.map(() => "add" as const)];
  }
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: ("eq" | "del" | "add")[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push("eq");
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push("del");
      i++;
    } else {
      ops.push("add");
      j++;
    }
  }
  while (i++ < n) ops.push("del");
  while (j++ < m) ops.push("add");
  return ops;
}

/**
 * Line diff of `before` → `after` with three lines of context around each change, as shown on
 * approval cards. Long diffs are cut at 400 lines (`truncated`).
 */
export function lineDiff(before: string, after: string): { lines: DiffLine[]; truncated: boolean } {
  const a = splitLines(before);
  const b = splitLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
    suffix++;
  }

  type Row = { kind: "add" | "del" | "ctx"; text: string; oldLine: number; newLine: number };
  const rows: Row[] = [];
  for (let k = 0; k < prefix; k++) rows.push({ kind: "ctx", text: a[k], oldLine: k + 1, newLine: k + 1 });
  const ops = middleDiff(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix));
  let oi = prefix;
  let ni = prefix;
  for (const op of ops) {
    if (op === "eq") rows.push({ kind: "ctx", text: a[oi++], oldLine: oi, newLine: ++ni });
    else if (op === "del") rows.push({ kind: "del", text: a[oi++], oldLine: oi, newLine: ni });
    else rows.push({ kind: "add", text: b[ni++], oldLine: oi, newLine: ni });
  }
  for (let k = a.length - suffix; k < a.length; k++) {
    rows.push({ kind: "ctx", text: a[k], oldLine: k + 1, newLine: k + 1 - a.length + b.length });
  }

  // Keep only changed rows plus context; collapse the rest into "gap" markers.
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((row, idx) => {
    if (row.kind === "ctx") return;
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(rows.length - 1, idx + CONTEXT); k++) keep[k] = true;
  });
  const lines: DiffLine[] = [];
  let skipping = false;
  rows.forEach((row, idx) => {
    if (!keep[idx]) {
      if (!skipping && lines.length > 0) lines.push({ kind: "gap", text: "…" });
      skipping = true;
      return;
    }
    skipping = false;
    lines.push({ kind: row.kind, text: row.text, line: row.kind === "add" ? row.newLine : row.oldLine });
  });
  if (lines.at(-1)?.kind === "gap") lines.pop();
  const truncated = lines.length > MAX_LINES;
  return { lines: truncated ? lines.slice(0, MAX_LINES) : lines, truncated };
}
