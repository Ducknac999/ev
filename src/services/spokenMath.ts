import { calculate } from "../providers/agent/liveTools";
import { formatNumber } from "../providers/agent/graph";

/**
 * Spoken arithmetic, worked out on the Mac with no AI: "what's two times three times four",
 * "15 percent of 80", "half of 250", "12 squared", "square root of 144", "2 to the power of 10".
 * Word problems ("if I have 3 apples…") aren't arithmetic in this sense: they go to the AI.
 */

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1_000_000, billion: 1_000_000_000 };

/** "one hundred twenty five" → "125" inside a sentence. */
function numberWords(text: string): string {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let total = 0;
  let current = 0;
  let inNumber = false;
  const flush = () => {
    if (inNumber) out.push(String(total + current));
    total = current = 0;
    inNumber = false;
  };
  for (const raw of words) {
    const w = raw.replace(/-/g, " ");
    if (w.includes(" ")) {
      // "twenty-five"
      const [a, b] = w.split(" ");
      if (a in TENS && b in UNITS) {
        current += TENS[a] + UNITS[b];
        inNumber = true;
        continue;
      }
    }
    if (w in UNITS) current += UNITS[w];
    else if (w in TENS) current += TENS[w];
    else if (w in SCALES && (inNumber || w === "hundred")) {
      const scale = SCALES[w];
      if (scale === 100) current = (current || 1) * 100;
      else {
        total += (current || 1) * scale;
        current = 0;
      }
    } else if (w === "a" && /^(hundred|thousand|million)$/.test(words[words.indexOf(raw) + 1] ?? "")) {
      current = 1;
    } else if (w === "and" && inNumber) {
      continue;
    } else {
      flush();
      out.push(raw);
      continue;
    }
    inNumber = true;
  }
  flush();
  return out.join(" ");
}

/** The arithmetic in a request, as an expression for the calculator; null when it isn't plain math. */
export function toExpression(input: string): string | null {
  let t = ` ${input.toLowerCase().replace(/[?!]+/g, " ").replace(/,(?=\d{3}\b)/g, "")} `;
  t = t.replace(/\b(?:um+|uh+|hey|ok(?:ay)?|so|please|e\.?v\.?|evie|eevee)\b/g, " ");
  t = t.replace(/^\s*(?:(?:can|could)\s+you\s+)?(?:what(?:'s|\s+is|\s+are)?|how\s+much\s+is|calculate|compute|work\s+out|tell\s+me|figure\s+out)\b/, " ");
  t = numberWords(t.trim().replace(/\s+/g, " "));
  t = ` ${t} `
    .replace(/\bhalf\s+of\b/g, " 0.5 * ")
    .replace(/\b(?:a\s+)?quarter\s+of\b/g, " 0.25 * ")
    .replace(/\bsquare\s+root\s+of\s+([\d.]+)/g, " sqrt($1) ")
    .replace(/\bpercent\s+of\b|%\s*of\b/g, " / 100 * ")
    .replace(/\bto\s+the\s+power\s+of\b/g, " ^ ")
    .replace(/\bsquared\b/g, " ^ 2 ")
    .replace(/\bcubed\b/g, " ^ 3 ")
    .replace(/\b(?:multiplied\s+by|times|x)\b/g, " * ")
    .replace(/\b(?:divided\s+by|over)\b/g, " / ")
    .replace(/\bdivide\s+([\d.]+)\s+by\s+([\d.]+)/g, " $1 / $2 ")
    .replace(/\b(?:plus|and|add)\b/g, " + ")
    .replace(/\b(?:minus|less)\b/g, " - ")
    .replace(/\b(?:equals?|is|the|of)\s*$/g, " ")
    .replace(/[×]/g, "*")
    .replace(/[÷]/g, "/")
    .replace(/\s+/g, " ")
    .trim();
  // Only digits, operators, parentheses and sqrt: anything else (a word) means it isn't plain math.
  if (!t || !/\d/.test(t) || !/^(?:[\d.\s+\-*/^()%]|sqrt)+$/.test(t)) return null;
  if (!/[+\-*/^]|sqrt/.test(t)) return null;
  return t;
}

/** "2 × 3 × 4 = 24", or null when it isn't plain math. */
export function solveSpoken(input: string): { shown: string; spoken: string } | null {
  const expression = toExpression(input);
  if (!expression) return null;
  try {
    const value = calculate(expression);
    if (!Number.isFinite(value)) return null;
    const answer = formatNumber(Math.round(value * 1e10) / 1e10);
    const pretty = expression.replace(/\*/g, "×").replace(/\//g, "÷").replace(/\s*\^\s*/g, "^");
    return { shown: `${pretty} = **${answer}**`, spoken: `${answer}.` };
  } catch {
    return null;
  }
}
