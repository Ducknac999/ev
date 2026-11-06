/**
 * Graphs drawn right in the chat: reads ordinary math ("x^3 - 2x - 5", "2sin x", "|x| - 1",
 * "x^2 = 4"), finds roots, intersections, turning points and the y-intercept numerically, and turns
 * each curve into LaTeX for Desmos. No AI and no network involved.
 */

type Node =
  | { k: "num"; v: number }
  | { k: "x" }
  | { k: "const"; name: "pi" | "e" }
  | { k: "neg"; a: Node }
  | { k: "bin"; op: "+" | "-" | "*" | "/" | "^"; a: Node; b: Node }
  | { k: "fn"; name: string; a: Node };

const FUNCTIONS: Record<string, (v: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  sec: (v) => 1 / Math.cos(v),
  csc: (v) => 1 / Math.sin(v),
  cot: (v) => 1 / Math.tan(v),
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  arcsin: Math.asin,
  arccos: Math.acos,
  arctan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  abs: Math.abs,
  ln: Math.log,
  log: Math.log10,
  log2: Math.log2,
  exp: Math.exp,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
};
const NAMES = [...Object.keys(FUNCTIONS), "pi", "x", "e"].sort((a, b) => b.length - a.length);

type Token = { t: "num"; v: number } | { t: "name"; v: string } | { t: "op"; v: string };

function normalize(src: string): string {
  return src
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/[×·∙]/g, "*")
    .replace(/÷/g, "/")
    .replace(/[−–—]/g, "-")
    .replace(/√/g, "sqrt")
    .replace(/π/g, "pi")
    .replace(/\*\*/g, "^")
    .replace(/\\cdot/g, "*")
    .replace(/\\left|\\right/g, "")
    .replace(/\\(sqrt|sin|cos|tan|ln|log|pi|exp)/g, "$1")
    .replace(/[{[]/g, "(")
    .replace(/[}\]]/g, ")");
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    if (/[a-z]/i.test(ch)) {
      const rest = src.slice(i).toLowerCase();
      const name = NAMES.find((n) => rest.startsWith(n));
      if (!name) throw new Error(`unknown name "${/^[a-z]+/i.exec(src.slice(i))![0]}" — only x can be a variable`);
      out.push({ t: "name", v: name });
      i += name.length;
      continue;
    }
    if ("+-*/^()|".includes(ch)) {
      out.push({ t: "op", v: ch });
      i++;
      continue;
    }
    throw new Error(`can't read "${ch}"`);
  }
  return out;
}

export function parse(input: string): Node {
  const tokens = tokenize(normalize(input));
  let pos = 0;
  let absDepth = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const startsAtom = () => {
    const tk = peek();
    if (!tk) return false;
    if (tk.t !== "op") return true;
    return tk.v === "(" || (tk.v === "|" && absDepth === 0);
  };

  const expr = (): Node => {
    let node = term();
    while (isOp("+") || isOp("-")) {
      const op = (tokens[pos++] as { v: "+" | "-" }).v;
      node = { k: "bin", op, a: node, b: term() };
    }
    return node;
  };
  const term = (): Node => {
    let node = unary();
    for (;;) {
      if (isOp("*") || isOp("/")) {
        const op = (tokens[pos++] as { v: "*" | "/" }).v;
        node = { k: "bin", op, a: node, b: unary() };
      } else if (startsAtom()) {
        node = { k: "bin", op: "*", a: node, b: power() };
      } else return node;
    }
  };
  const unary = (): Node => {
    if (isOp("-")) {
      pos++;
      return { k: "neg", a: unary() };
    }
    if (isOp("+")) {
      pos++;
      return unary();
    }
    return power();
  };
  const power = (): Node => {
    const base = atom();
    if (isOp("^")) {
      pos++;
      return { k: "bin", op: "^", a: base, b: unary() };
    }
    return base;
  };
  const atom = (): Node => {
    const tk = tokens[pos++];
    if (!tk) throw new Error("the expression ends too early");
    if (tk.t === "num") return { k: "num", v: tk.v };
    if (tk.t === "name") {
      if (tk.v === "x") return { k: "x" };
      if (tk.v === "pi" || tk.v === "e") return { k: "const", name: tk.v };
      // A function: "sin(x)" or "sin x".
      return { k: "fn", name: tk.v, a: isOp("(") ? atom() : power() };
    }
    if (tk.v === "(") {
      const inner = expr();
      if (!isOp(")")) throw new Error("missing )");
      pos++;
      return inner;
    }
    if (tk.v === "|") {
      absDepth++;
      const inner = expr();
      absDepth--;
      if (!isOp("|")) throw new Error("missing closing |");
      pos++;
      return { k: "fn", name: "abs", a: inner };
    }
    throw new Error(`unexpected "${tk.v}"`);
  };

  const node = expr();
  if (pos < tokens.length) throw new Error(`unexpected "${(tokens[pos] as { v: unknown }).v}"`);
  return node;
}

export function compile(node: Node): (x: number) => number {
  switch (node.k) {
    case "num": {
      const v = node.v;
      return () => v;
    }
    case "x":
      return (x) => x;
    case "const": {
      const v = node.name === "pi" ? Math.PI : Math.E;
      return () => v;
    }
    case "neg": {
      const a = compile(node.a);
      return (x) => -a(x);
    }
    case "fn": {
      const f = FUNCTIONS[node.name];
      const a = compile(node.a);
      return (x) => f(a(x));
    }
    case "bin": {
      const a = compile(node.a);
      const b = compile(node.b);
      switch (node.op) {
        case "+":
          return (x) => a(x) + b(x);
        case "-":
          return (x) => a(x) - b(x);
        case "*":
          return (x) => a(x) * b(x);
        case "/":
          return (x) => a(x) / b(x);
        case "^": {
          // Odd roots of negatives (x^(1/3)) are real.
          const exponent = node.b.k === "bin" && node.b.op === "/" && node.b.a.k === "num" && node.b.b.k === "num" ? [node.b.a.v, node.b.b.v] : null;
          return (x) => {
            const base = a(x);
            const p = b(x);
            if (base < 0 && exponent && exponent[1] % 2 === 1) return -Math.pow(-base, p);
            return Math.pow(base, p);
          };
        }
      }
    }
  }
}

// ── LaTeX for Desmos ──────────────────────────────────────────────────────────

const PREC = { "+": 1, "-": 1, "*": 2, "/": 2, neg: 3, "^": 4 } as const;
const LATEX_FN: Record<string, string> = {
  sin: "\\sin", cos: "\\cos", tan: "\\tan", sec: "\\sec", csc: "\\csc", cot: "\\cot", asin: "\\arcsin", acos: "\\arccos", atan: "\\arctan",
  arcsin: "\\arcsin", arccos: "\\arccos", arctan: "\\arctan", sinh: "\\sinh", cosh: "\\cosh", tanh: "\\tanh", ln: "\\ln", log: "\\log",
  log2: "\\log_{2}", floor: "\\operatorname{floor}", ceil: "\\operatorname{ceil}", round: "\\operatorname{round}",
};

const prec = (n: Node): number => (n.k === "bin" ? PREC[n.op] : n.k === "neg" ? PREC.neg : 5);
const wrap = (s: string) => `\\left(${s}\\right)`;

export function toLatex(node: Node): string {
  const at = (child: Node, min: number) => (prec(child) < min ? wrap(toLatex(child)) : toLatex(child));
  switch (node.k) {
    case "num":
      return formatNumber(node.v);
    case "x":
      return "x";
    case "const":
      return node.name === "pi" ? "\\pi" : "e";
    case "neg":
      return `-${at(node.a, PREC.neg)}`;
    case "fn":
      if (node.name === "sqrt") return `\\sqrt{${toLatex(node.a)}}`;
      if (node.name === "cbrt") return `\\sqrt[3]{${toLatex(node.a)}}`;
      if (node.name === "abs") return `\\left|${toLatex(node.a)}\\right|`;
      if (node.name === "exp") return `e^{${toLatex(node.a)}}`;
      return `${LATEX_FN[node.name] ?? `\\operatorname{${node.name}}`}${wrap(toLatex(node.a))}`;
    case "bin":
      switch (node.op) {
        case "+":
          return `${at(node.a, 1)}+${at(node.b, 1)}`;
        case "-":
          return `${at(node.a, 1)}-${at(node.b, 2)}`;
        case "/":
          return `\\frac{${toLatex(node.a)}}{${toLatex(node.b)}}`;
        case "^": {
          const base = node.a.k === "num" || node.a.k === "x" || node.a.k === "const" ? toLatex(node.a) : wrap(toLatex(node.a));
          return `${base}^{${toLatex(node.b)}}`;
        }
        case "*": {
          const left = at(node.a, 2);
          const right = at(node.b, 2);
          // "2x", "3\sin(x)": side by side; two numbers need a dot.
          return /^[\d.]/.test(right) || node.a.k !== "num" ? `${left}\\cdot ${right}` : `${left}${right}`;
        }
      }
  }
}

// ── Reading what the user wants graphed ───────────────────────────────────────

export interface Curve {
  /** As given, e.g. "y = x^3 - 2x - 5". */
  label: string;
  /** Plain expression in x that E.V evaluates. */
  expr: string;
  latex: string;
}

export interface GraphInput {
  curves: Curve[];
  /** Equations in x alone ("x^2 = 4"): solved as left = right. */
  equations: { label: string; left: string; right: string; latex: string }[];
}

export function readGraphInput(lines: string[]): GraphInput {
  const curves: Curve[] = [];
  const equations: GraphInput["equations"] = [];
  for (const raw of lines.map((l) => l.trim()).filter(Boolean)) {
    const parts = raw.split("=");
    if (parts.length > 2) throw new Error(`"${raw}" has more than one =`);
    if (parts.length === 2) {
      const [left, right] = parts.map((p) => p.trim());
      if (/^(y|[a-z]\s*\(\s*x\s*\))$/i.test(left)) {
        const node = parse(right);
        curves.push({ label: raw, expr: right, latex: `y=${toLatex(node)}` });
        continue;
      }
      if (/\by\b/i.test(raw)) throw new Error(`"${raw}" isn't of the form y = …; only curves y = f(x) and equations in x are supported`);
      const l = parse(left);
      const r = parse(right);
      equations.push({ label: raw, left, right, latex: `${toLatex(l)}=${toLatex(r)}` });
      continue;
    }
    const node = parse(raw);
    curves.push({ label: `y = ${raw}`, expr: raw, latex: `y=${toLatex(node)}` });
  }
  if (!curves.length && !equations.length) throw new Error("nothing to graph");
  return { curves, equations };
}

// ── Finding the interesting points ────────────────────────────────────────────

export interface GraphPoint {
  x: number;
  y: number;
  kind: "root" | "solution" | "intersection" | "max" | "min" | "y-intercept";
  /** Which curve(s), by label. */
  of: string;
}

export interface GraphView {
  xmin: number;
  xmax: number;
  ymin: number;
  ymax: number;
}

export interface GraphResult {
  input: GraphInput;
  points: GraphPoint[];
  view: GraphView;
}

const SEARCH: [number, number] = [-60, 60];
const SAMPLES = 24_000;

function bisect(g: (x: number) => number, lo: number, hi: number): number {
  let glo = g(lo);
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const gm = g(mid);
    if (gm === 0) return mid;
    if (Math.sign(gm) === Math.sign(glo)) {
      lo = mid;
      glo = gm;
    } else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Minimises g on [a, b] (golden section). */
function goldenMin(g: (x: number) => number, a: number, b: number): number {
  const r = (Math.sqrt(5) - 1) / 2;
  let c = b - r * (b - a);
  let d = a + r * (b - a);
  for (let i = 0; i < 90; i++) {
    if (g(c) < g(d)) b = d;
    else a = c;
    c = b - r * (b - a);
    d = a + r * (b - a);
  }
  return (a + b) / 2;
}

/** Every x in [a, b] where g crosses or touches zero (poles and jumps are left out). */
export function findZeros(g: (x: number) => number, a = SEARCH[0], b = SEARCH[1], n = SAMPLES): number[] {
  const step = (b - a) / n;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i <= n; i++) {
    const x = a + i * step;
    xs.push(x);
    ys.push(g(x));
  }
  const zeros: number[] = [];
  const add = (z: number) => {
    const gz = Math.abs(g(z));
    if (!Number.isFinite(gz) || gz > 1e-6) return;
    if (zeros.some((p) => Math.abs(p - z) < step * 1.5)) return;
    zeros.push(z);
  };
  for (let i = 0; i < n; i++) {
    const [y0, y1] = [ys[i], ys[i + 1]];
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) continue;
    if (y0 === 0) add(xs[i]);
    else if (Math.sign(y0) !== Math.sign(y1) && y1 !== 0) add(bisect(g, xs[i], xs[i + 1]));
  }
  // Touching zeros (like x² at 0): local minima of |g| that reach zero.
  for (let i = 1; i < n; i++) {
    const [p, c, q] = [Math.abs(ys[i - 1]), Math.abs(ys[i]), Math.abs(ys[i + 1])];
    if (Number.isFinite(c) && c <= p && c <= q && c < 1e-2 && Math.sign(ys[i - 1]) === Math.sign(ys[i + 1])) {
      add(goldenMin((x) => Math.abs(g(x)), xs[i - 1], xs[i + 1]));
    }
  }
  return zeros.sort((p, q) => p - q);
}

/** Turning points (local max / min) of f in [a, b]. */
export function findTurns(f: (x: number) => number, a: number, b: number, n = 6000): { x: number; y: number; kind: "max" | "min" }[] {
  const step = (b - a) / n;
  const out: { x: number; y: number; kind: "max" | "min" }[] = [];
  let prev = f(a);
  let cur = f(a + step);
  for (let i = 1; i < n; i++) {
    const next = f(a + (i + 1) * step);
    if ([prev, cur, next].every(Number.isFinite)) {
      const isMax = cur > prev && cur >= next;
      const isMin = cur < prev && cur <= next;
      if (isMax || isMin) {
        const x0 = a + (i - 1) * step;
        const x = goldenMin((t) => (isMax ? -f(t) : f(t)), x0, x0 + 2 * step);
        const y = f(x);
        // Corners of jumps and spikes next to poles aren't turning points.
        if (Number.isFinite(y) && Math.abs(y) < 1e6 && !out.some((p) => Math.abs(p.x - x) < step * 2)) out.push({ x, y, kind: isMax ? "max" : "min" });
      }
    }
    prev = cur;
    cur = next;
  }
  return out;
}

export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Math.abs(v - Math.round(v)) < 1e-9) return String(Math.round(v));
  const s = Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(4);
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

const near = (v: number) => (Math.abs(v - Math.round(v)) < 1e-9 ? "=" : "≈");

export function analyzeGraph(input: GraphInput, range?: [number, number]): GraphResult {
  const fs = input.curves.map((c) => ({ c, f: compile(parse(c.expr)) }));
  const points: GraphPoint[] = [];
  for (const { c, f } of fs) {
    for (const x of findZeros(f)) points.push({ x, y: 0, kind: "root", of: c.label });
    const y0 = f(0);
    if (Number.isFinite(y0)) points.push({ x: 0, y: y0, kind: "y-intercept", of: c.label });
  }
  for (const eq of input.equations) {
    const l = compile(parse(eq.left));
    const r = compile(parse(eq.right));
    for (const x of findZeros((x) => l(x) - r(x))) points.push({ x, y: l(x), kind: "solution", of: eq.label });
  }
  for (let i = 0; i < fs.length; i++) {
    for (let j = i + 1; j < fs.length; j++) {
      const [a, b] = [fs[i], fs[j]];
      for (const x of findZeros((x) => a.f(x) - b.f(x))) points.push({ x, y: a.f(x), kind: "intersection", of: `${a.c.label} and ${b.c.label}` });
    }
  }

  // The view: the asked range, or one that shows every point found (but not ±60 for one far root).
  const xs = points.filter((p) => p.kind !== "y-intercept").map((p) => p.x);
  let [xmin, xmax] = range ?? [-10, 10];
  if (!range && xs.length) {
    const lo = Math.min(0, ...xs);
    const hi = Math.max(0, ...xs);
    const pad = Math.max(2, (hi - lo) * 0.3);
    [xmin, xmax] = [lo - pad, hi + pad];
    if (xmax - xmin < 8) {
      const mid = (xmin + xmax) / 2;
      [xmin, xmax] = [mid - 4, mid + 4];
    }
  }
  for (const { c, f } of fs) {
    for (const t of findTurns(f, xmin, xmax).slice(0, 8)) points.push({ x: t.x, y: t.y, kind: t.kind, of: c.label });
  }
  const view = { xmin, xmax, ...yRange(fs.map((x) => x.f).concat(input.equations.flatMap((e) => [compile(parse(e.left)), compile(parse(e.right))])), xmin, xmax, points) };
  return { input, points, view };
}

function yRange(fs: ((x: number) => number)[], xmin: number, xmax: number, points: GraphPoint[]): { ymin: number; ymax: number } {
  const values: number[] = [];
  for (const f of fs) {
    for (let i = 0; i <= 400; i++) {
      const y = f(xmin + ((xmax - xmin) * i) / 400);
      if (Number.isFinite(y)) values.push(y);
    }
  }
  values.sort((a, b) => a - b);
  const pick = (q: number) => values[Math.min(values.length - 1, Math.max(0, Math.round(q * (values.length - 1))))] ?? 0;
  const inView = points.filter((p) => p.x >= xmin && p.x <= xmax).map((p) => p.y);
  let lo = Math.min(pick(0.03), 0, ...inView);
  let hi = Math.max(pick(0.97), 0, ...inView);
  if (hi - lo < 1e-9) [lo, hi] = [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.12;
  return { ymin: lo - pad, ymax: hi + pad };
}

/** What the AI is told (it then explains it to the user). */
export function describeGraph(result: GraphResult): string {
  const { points, view } = result;
  const lines = [`Graph drawn in the chat (x from ${formatNumber(view.xmin)} to ${formatNumber(view.xmax)}).`];
  const labels = [...result.input.curves.map((c) => c.label), ...result.input.equations.map((e) => e.label)];
  for (const label of labels) {
    const mine = points.filter((p) => p.of === label);
    const roots = mine.filter((p) => p.kind === "root" || p.kind === "solution");
    const isEquation = mine.some((p) => p.kind === "solution") || result.input.equations.some((e) => e.label === label);
    lines.push(`${label}:`);
    if (isEquation) lines.push(roots.length ? `- solutions: ${roots.map((p) => `x ${near(p.x)} ${formatNumber(p.x)}`).join(", ")}` : "- no real solutions between x = -60 and 60");
    else lines.push(roots.length ? `- roots (crosses the x-axis): ${roots.map((p) => `x ${near(p.x)} ${formatNumber(p.x)}`).join(", ")}` : "- no real roots between x = -60 and 60");
    const yi = mine.find((p) => p.kind === "y-intercept");
    if (yi) lines.push(`- y-intercept: (0, ${formatNumber(yi.y)})`);
    const turns = mine.filter((p) => p.kind === "max" || p.kind === "min");
    if (turns.length) lines.push(`- turning points in view: ${turns.map((p) => `local ${p.kind} ${near(p.x)} (${formatNumber(p.x)}, ${formatNumber(p.y)})`).join("; ")}`);
  }
  for (const p of points.filter((p) => p.kind === "intersection")) lines.push(`- ${p.of} meet at (${formatNumber(p.x)}, ${formatNumber(p.y)})`);
  lines.push("Values were found numerically (about 4 decimal places): say ≈ unless they're exact. The user sees the graph with these points marked; there's an Open in Desmos button under it.");
  return lines.join("\n");
}
