import type { ToolStep } from "../types";

/**
 * Learned routes: when a task on the Mac or the web works, E.V keeps the steps that did it.
 * The next similar request starts with that route, so the AI goes straight there — one or two
 * batched calls instead of exploring again.
 */

export interface Recipe {
  id: string;
  /** The request that worked, as the user said it. */
  goal: string;
  /** The steps, as shown on the cards. */
  steps: string[];
  createdAt: number;
  uses: number;
}

/** Actions worth remembering (looking alone isn't a route). */
const ROUTE_TOOLS = new Set(["mac_open", "mac_do", "mac_click", "mac_drag", "mac_menu", "mac_type", "mac_key", "mac_applescript", "mac_shortcut", "browser_go", "browser_do", "make_graph"]);
const STOP = new Set(
  "the a an and or to of in on for at with my me i you your it this that please can could would will just then also go open use do make tell show get".split(" "),
);
const LIMIT = 80;

export function goalWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

export function similarity(a: string, b: string): number {
  const [x, y] = [goalWords(a), goalWords(b)];
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

export function findRecipe(text: string, recipes: Recipe[]): Recipe | null {
  let best: Recipe | null = null;
  let score = 0.5;
  for (const r of recipes) {
    const s = similarity(text, r.goal);
    if (s >= score) [best, score] = [r, s];
  }
  return best;
}

/** The route a finished task took, or null when there's nothing worth keeping. */
export function routeOf(steps: ToolStep[]): string[] | null {
  const actions = steps.filter((s) => ROUTE_TOOLS.has(s.name));
  if (actions.length < 2 || actions.some((s) => s.status === "denied") || actions.at(-1)?.status !== "done") return null;
  // Failed attempts that were retried another way aren't part of the route.
  return actions.filter((s) => s.status === "done").map((s) => s.title).slice(0, 12);
}

export function learn(recipes: Recipe[], goal: string, steps: string[], id: string, now = Date.now()): Recipe[] {
  const same = recipes.find((r) => similarity(r.goal, goal) >= 0.8);
  const next: Recipe = { id: same?.id ?? id, goal, steps, createdAt: now, uses: same?.uses ?? 0 };
  return [...recipes.filter((r) => r !== same), next].slice(-LIMIT);
}

export function recipePrompt(recipe: Recipe): string {
  return [
    "# A route that worked before",
    `A similar request ("${recipe.goal}") was done like this:`,
    ...recipe.steps.map((s, i) => `${i + 1}. ${s}`),
    "Follow the same route where it fits this request, batching the steps with browser_do / mac_do instead of exploring. If the page or app has changed, work it out again.",
  ].join("\n");
}
