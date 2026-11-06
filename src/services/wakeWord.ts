/**
 * "Hey E.V": in Talk mode nothing reaches an AI unless it starts with the wake phrase, or
 * comes within the conversation window after E.V's last answer.
 */

// Speech recognition writes "E.V" many ways ("EV", "Evie", "Eevee", "Hey V"), and sometimes
// runs it into the greeting ("HEV", "Havy"). Real words such as "every" or "heavy" are not
// accepted: "Hey, every time I…" isn't for E.V.
const FULL_NAME = String.raw`(?:[ea]\.?[\s-]?v\.?|e\.?[\s-]?b\.?|evie|eevee|eevie|evey|evy|eve)(?![a-z'])`;
const NAME = String.raw`(?:${FULL_NAME}|v\.?(?![a-z'])|easy(?![a-z']))`;
const GREETING = String.raw`(?:hey|hi|hay|hai|okay|ok|yo|a|say|hey\s+there)`;
const MERGED = String.raw`(?:hev|havy|havie|hevy|hevie|heyev|heyevie|ke\.?\s?v\.?)(?![a-z'])`;
const WAKE = new RegExp(String.raw`^\s*(?:${GREETING}[\s,.!-]*${NAME}|${MERGED})[\s,.!?:;\-–—]*`, "i");

// While E.V talks its own words are mixed in and its voice swallows "Hey" ("A E V, stop",
// "Dear Evie, stop"): look anywhere in the text. A bare "V" counts only after a real greeting,
// so E.V's own sentences ("a V value") can't interrupt it.
const LOUD_GREETING = String.raw`(?:hey|hi|hay|hai|okay|ok|yo)`;
const SOFT_GREETING = String.raw`(?:a|dear|hey\s+a)`;
// Loud over E.V's voice, "Hey E.V, stop" can come out as "ADD, stop": only with "stop" right after.
const BLURRED_STOP = String.raw`(?:a\s?e\.?\s?d|add)(?=[,.]?\s+stop\b)`;
const WAKE_ANYWHERE = new RegExp(
  String.raw`(?:(?:^|[\s,.!?])(?:${LOUD_GREETING}[\s,.!-]*${NAME}|${SOFT_GREETING}[\s,.!-]*${FULL_NAME}|${MERGED}|${BLURRED_STOP}))[\s,.!?:;\-–—]*`,
  "i",
);

/** "Hey E.V" anywhere in what was heard (used while E.V is speaking). */
export function findWake(text: string): { rest: string } | null {
  const match = WAKE_ANYWHERE.exec(text);
  return match ? { rest: text.slice(match.index + match[0].length).trim() } : null;
}

export type Heard = { wake: true; rest: string } | { wake: false; text: string };

export function parseWake(text: string): Heard {
  const match = WAKE.exec(text);
  return match ? { wake: true, rest: text.slice(match[0].length).trim() } : { wake: false, text: text.trim() };
}

const END = /^\s*(?:that'?s\s+all|that\s+is\s+all|thanks?,?\s+(?:e\.?\s?v\.?|evie|eevee|eevie|evey|evy|eve)|thank\s+you,?\s+(?:e\.?\s?v\.?|evie|eevee|eevie|evey|evy|eve)|never\s*mind|stop\s+listening|we'?re\s+done|i'?m\s+done)\b[\s.!,]*$/i;

/** "That's all", "Thanks E.V", "Never mind" — ends the conversation. */
export function isEndPhrase(text: string): boolean {
  return END.test(text);
}

/** "Hey E.V, stop" — interrupts the current answer. */
export function isStopCommand(text: string): boolean {
  return /^\s*(?:stop|be\s+quiet|shut\s+up|cancel|quiet|enough|shh+|hush|sh+)\b[\s.!,]*$/i.test(text);
}

const JOINING_WORDS = /\b(?:and|or|but|so|then|to|the|a|an|my|with|for|of|in|on|at|that|which|because|if|when|also|plus|um+|uh+)$/i;

/**
 * "Open Discord, go to my chat with Chris," — a pause, but not the end. Ends with a comma, a dash
 * or a joining word, so E.V waits a moment for the rest before acting.
 */
export function soundsUnfinished(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/[,;:\-–—]$/.test(t)) return true;
  return JOINING_WORDS.test(t.replace(/[.…]+$/, "").trim()) && !/[?!]$/.test(t);
}
