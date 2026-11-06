import { speakMath } from "./mathSpeech";

const FENCE = "```";

const ORDINALS = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth"];

/**
 * Says written shorthand the way a person would: numbered items become "First, …", divider
 * lines disappear (they used to come out as "minus"), "~6.4M" is "about 6.4 million" and a
 * video length "14:13" is "14 minutes 13 seconds".
 */
export function humanize(markdown: string): string {
  return markdown
    .replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm, " ")
    .replace(/^(\s{0,3}#{0,6}\s*)(\d{1,2})[.)]\s+/gm, (_m, lead: string, n: string) => `${lead}${ORDINALS[Number(n) - 1] ?? `Number ${n}`}, `)
    .replace(/(^|[\s(])[~≈]\s?(?=[\d$])/g, "$1about ")
    .replace(/\b(\d+(?:\.\d+)?)\s?([KMB])\b(?!\w)/g, (_m, n: string, unit: string) => `${n} ${{ K: "thousand", M: "million", B: "billion" }[unit as "K" | "M" | "B"]}`)
    .replace(/\b(length|duration|long|runtime|runs)(\W{1,6})(\d{1,2}):(\d{2})(?::(\d{2}))?\b/gi, (_m, word: string, sep: string, a: string, b: string, c?: string) =>
      c ? `${word}${sep}${Number(a)} hours ${Number(b)} minutes ${Number(c)} seconds` : `${word}${sep}${Number(a)} minutes ${Number(b)} seconds`,
    );
}

/** Converts markdown into plain prose suitable for a speech engine. */
export function toSpokenText(markdown: string): string {
  return speakMath(humanize(markdown.replace(/```[\s\S]*?```/g, " ")))
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " link ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/[*_#>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Given the full streamed text and how much has already been spoken, returns the next chunk of
 * complete sentences to speak. Never splits inside an unterminated code fence. When `done`
 * is true, the whole remainder is returned.
 */
export function takeSpeakable(raw: string, offset: number, done: boolean): { segment: string; next: number } {
  let region = raw.slice(offset);
  if (!done) {
    const fences = region.split(FENCE).length - 1;
    if (fences % 2 === 1) region = region.slice(0, region.lastIndexOf(FENCE));
    const boundary = lastSentenceBoundary(region);
    if (boundary <= 0) return { segment: "", next: offset };
    region = region.slice(0, boundary);
  }
  return { segment: toSpokenText(region), next: offset + region.length };
}

function lastSentenceBoundary(text: string): number {
  const re = /([.!?…]["')\]]?)(\s+)|\n\s*\n/g;
  let last = -1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    // "2. " starting a numbered line isn't the end of a sentence.
    if (/(^|\n)\s{0,3}#{0,6}\s*\d{1,2}$/.test(text.slice(0, match.index))) continue;
    last = match.index + match[0].length;
  }
  return last;
}
