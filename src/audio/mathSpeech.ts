/**
 * Says maths the way a person reads it aloud: "$(g \circ f)(x) = 4$" → "g of f of x equals 4",
 * "\frac{x+4}{7}" → "x plus 4 over 7". Used only for speech; the chat still shows real notation.
 */

const GREEK = ["alpha", "beta", "gamma", "delta", "epsilon", "theta", "lambda", "mu", "pi", "sigma", "phi", "omega", "rho", "tau"];

const WORDS: [RegExp, string][] = [
  [/\\(?:left|right|displaystyle|,|;|!|quad|qquad)\b|\\[,;!]/g, " "],
  [/\\(?:text|mathrm|mathbf|mathit|operatorname)\{([^{}]*)\}/g, " $1 "],
  [/\\(?:cdot|times)/g, " times "],
  [/\\div/g, " divided by "],
  [/\\pm/g, " plus or minus "],
  [/\\mp/g, " minus or plus "],
  [/\\(?:neq|ne)\b/g, " is not equal to "],
  [/\\(?:leq|le)\b/g, " is less than or equal to "],
  [/\\(?:geq|ge)\b/g, " is greater than or equal to "],
  [/\\approx/g, " is approximately "],
  [/\\infty/g, " infinity "],
  [/\\(?:to|rightarrow)\b/g, " goes to "],
  [/\\Rightarrow|\\implies/g, " which means "],
  [/\\in\b/g, " in "],
  [/\\circ/g, " composed with "],
  [/\\degree|\^\{?\\circ\}?/g, " degrees "],
  [/\\%/g, " percent "],
];

function group(text: string, at: number): [string, number] {
  // text[at] === "{": returns the balanced contents and the index after the closing brace.
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return [text.slice(at + 1, i), i + 1];
  }
  return [text.slice(at + 1), text.length];
}

/** \frac{a}{b} and \sqrt{x}, with nesting. */
function structures(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const frac = /^\\[dt]?frac\s*/.exec(text.slice(i));
    const sqrt = /^\\sqrt\s*(?:\[([^\]]+)\])?\s*/.exec(text.slice(i));
    if (frac && text[i + frac[0].length] === "{") {
      const [top, next] = group(text, i + frac[0].length);
      const [bottom, end] = text[next] === "{" ? group(text, next) : ["", next];
      out += ` ${structures(top)} over ${structures(bottom)} `;
      i = end;
    } else if (sqrt && text[i + sqrt[0].length] === "{") {
      const [inside, end] = group(text, i + sqrt[0].length);
      out += sqrt[1] ? ` the ${sqrt[1] === "3" ? "cube" : `${sqrt[1]}th`} root of ${structures(inside)} ` : ` the square root of ${structures(inside)} `;
      i = end;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

const POWERS: Record<string, string> = { "2": "squared", "3": "cubed" };

export function mathToSpeech(expr: string): string {
  let t = structures(expr);
  for (const [re, word] of WORDS) t = t.replace(re, word);
  t = t.replace(new RegExp(`\\\\(${GREEK.join("|")})\\b`, "gi"), " $1 ");
  // (g ∘ f)(x) → "g of f of x"
  t = t.replace(/\(\s*([a-zA-Z])\s+composed with\s+([a-zA-Z])\s*\)\s*\(\s*([^()]+?)\s*\)/g, " $1 of $2 of $3 ");
  // Powers and subscripts.
  t = t.replace(/\^\{?\s*(-?[\w.]+)\s*\}?/g, (_, p: string) => ` ${POWERS[p] ?? `to the power of ${p}`} `);
  t = t.replace(/_\{?\s*([\w.]+)\s*\}?/g, " sub $1 ");
  // f(x) → "f of x" (single-letter function names).
  for (let i = 0; i < 3; i++) t = t.replace(/(^|[^a-zA-Z])([a-zA-Z])\s*\(([^()]*)\)/g, "$1$2 of $3 ");
  t = t
    .replace(/[{}\\]/g, " ")
    .replace(/(?<=[\w)])\s*-\s*(?=[\w(])/g, " minus ")
    .replace(/(^|[(=\s])-\s*(?=[\w(])/g, "$1 negative ")
    .replace(/\+/g, " plus ")
    .replace(/(?<![<>])=/g, " equals ")
    .replace(/<=/g, " is less than or equal to ")
    .replace(/>=/g, " is greater than or equal to ")
    .replace(/</g, " is less than ")
    .replace(/>/g, " is greater than ")
    .replace(/\//g, " over ")
    .replace(/\*/g, " times ")
    .replace(/[()[\]]/g, " ")
    .replace(/\s*,\s*/g, ", ");
  return t.replace(/\s+/g, " ").trim();
}

/** A line that is only a formula, e.g. "-(x + 4) / 7" or "x = 3". */
const FORMULA_LINE = /^\s*[-+(]*\s*(?:\d+(?:\.\d+)?|[a-zA-Z]\b|\()[\w\s().+\-*/^=<>]*$/;
const HAS_OPERATOR = /[+*/^=<>]|(?:^|\s|\()-|\w\s*-\s*\w/;
const WORDY = /[a-zA-Z]{3,}/;

/** Replaces every maths span in a reply ($…$, $$…$$, \(…\), \[…\]) with spoken words. */
export function speakMath(text: string): string {
  return text
    .split("\n")
    .map((line) => (FORMULA_LINE.test(line) && HAS_OPERATOR.test(line) && !WORDY.test(line) ? mathToSpeech(line) : line))
    .join("\n")
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, m: string) => ` ${mathToSpeech(m)} `)
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m: string) => ` ${mathToSpeech(m)} `)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m: string) => ` ${mathToSpeech(m)} `)
    .replace(/(?<![\\\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g, (_, m: string) => mathToSpeech(m))
    .replace(/(?<=[\w)])\s*\^\s*(\d+)/g, (_, p: string) => ` ${POWERS[p] ?? `to the power of ${p}`}`)
    // Inline plain-text maths like "x/2" or "3/4" (not "and/or").
    .replace(/(?<=(?:^|[\s(])(?:\d+|[a-zA-Z]))\/(?=(?:\d+|[a-zA-Z])(?:$|[\s).,]))/g, " over ");
}
