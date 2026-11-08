/**
 * What you said, tidied on the Mac before anything sees it (instant actions, the router, the AI):
 * no "um"/"uh", no stutters ("can you can you"), your own spellings for names ("Vor Saint" →
 * "Vorssaint"), "Friday, actually Thursday" → "Thursday". Shorter, cleaner requests match instant
 * actions more often and cost the AI fewer tokens. Instant (plain text work, no model).
 * Dictation into other apps also turns "comma", "new line"… into the marks themselves.
 */

/** A filler and the pause marks around it: "times, uh, 3" → "times 3". */
const FILLERS = /,?\s*(?<![\w'])(?:u+m+|u+h+m*|e+r+m+|hm+|mm+|ah+)(?![\w'])\s*,?/gi;

/** Words people double on purpose ("very very", "no no"): not stutters. */
const MEANT_TWICE = new Set(["very", "really", "so", "no", "yes", "bye", "ha", "go", "knock", "that", "had", "is"]);

const DAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight";
const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december";
const TIME = String.raw`\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|noon|midnight`;
const CORRECTION = String.raw`,?\s+(?:actually|no(?:\s+wait)?|wait|i\s+mean|sorry|make\s+(?:it|that))[,\s]+`;

/** "Friday, actually Thursday" → "Thursday" (days, months, times and numbers only: safe without AI). */
function selfCorrections(text: string): string {
  for (const kind of [DAYS, MONTHS, TIME, String.raw`\d+(?:\.\d+)?`]) {
    const re = new RegExp(String.raw`\b(?:${kind})${CORRECTION}((?:${kind}))\b`, "gi");
    text = text.replace(re, "$1");
  }
  return text;
}

function stutters(text: string): string {
  // "can you can you" → "can you", "I I think" → "I think" (1–3 words said twice in a row).
  return text.replace(/\b((?:[a-z']+\s+){0,2}[a-z']+)(?:[\s,]+\1\b)+/gi, (whole, phrase: string) => (MEANT_TWICE.has(phrase.toLowerCase()) ? whole : phrase));
}

/** Roughly how it sounds: "Vor Saint" and "Vorssaint" → "vorsaint", "duck nack" and "Ducknac" → "duknak". */
function sound(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/ck|q|c(?![eiy])/g, "k")
    .replace(/ph/g, "f")
    .replace(/z/g, "s")
    .replace(/(.)\1+/g, "$1");
}

/** Your dictionary's spellings for what the speech engine heard as one to three words. */
function dictionary(text: string, words: string[]): string {
  const entries = words.map((w) => w.trim()).filter((w) => w.length >= 2).map((w) => ({ word: w, key: sound(w) }));
  if (!entries.length) return text;
  const tokens = text.split(/(\s+)/);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    let matched = false;
    for (let span = 5; span >= 1 && !matched; span -= 2) {
      // `span` counts word and space tokens: 1, 3 and 5 = one, two and three words.
      const piece = tokens.slice(i, i + span);
      if (piece.length < span || /^\s/.test(piece[0])) continue;
      const trail = /[.,!?;:]+$/.exec(piece[piece.length - 1])?.[0] ?? "";
      const key = sound(piece.join(""));
      const hit = key.length >= 3 && entries.find((e) => e.key === key);
      if (hit) {
        out.push(hit.word + trail);
        i += span;
        matched = true;
      }
    }
    if (!matched) out.push(tokens[i++]);
  }
  return out.join("");
}

const SPOKEN_MARKS: [RegExp, string][] = [
  [/\s*\bnew paragraph\b\s*/gi, "\n\n"],
  [/\s*\bnew line\b\s*/gi, "\n"],
  [/\s*\b(?:comma)\b/gi, ","],
  [/\s*\b(?:period|full stop)\b/gi, "."],
  [/\s*\bquestion mark\b/gi, "?"],
  [/\s*\bexclamation (?:point|mark)\b/gi, "!"],
  [/\s*\bsemicolon\b/gi, ";"],
  [/\s*\bcolon\b/gi, ":"],
];

function tidy(text: string): string {
  return text
    .replace(/[ \t]+([,.!?;:])/g, "$1")
    .replace(/([,;:])(?:\s*[,;:])+/g, "$1")
    .replace(/,\s*([.!?])/g, "$1")
    .replace(/^[\s,;:]+/, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .trim()
    .replace(/^[a-z]/, (c) => c.toUpperCase())
    .replace(/([.!?]\s+|\n)([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
}

export type CleanupMode = "request" | "dictation";

export function cleanTranscript(raw: string, options: { dictionary?: string[]; mode?: CleanupMode } = {}): string {
  let text = ` ${raw} `;
  // How speech engines write E.V's name.
  text = text.replace(/\b(?:e\.?\s?v\.?|eevee|evie|eve)(?=[\s,.!?])/gi, "E.V");
  text = text.replace(FILLERS, " ");
  text = stutters(text);
  text = selfCorrections(text);
  text = dictionary(text, options.dictionary ?? []);
  if (options.mode === "dictation") for (const [re, mark] of SPOKEN_MARKS) text = text.replace(re, mark);
  const out = tidy(text);
  return out || raw.trim();
}
