import { macUserIdle } from "../lib/ipc";
import { describeMacTool, executeMacTool, type MacEnv, type ReplayStep } from "../providers/agent/macTools";

/**
 * Learned tasks: when a task on the Mac finishes and every action was confirmed by the window
 * changing, E.V keeps the exact steps (by label, never by number). The next time the same request
 * comes in, those steps run again with no AI at all; each one is checked the same way, and a step
 * that doesn't work hands the task back to the AI and drops the saved steps. (Method from Atticus,
 * github.com/SaarthurR/atticus-mac, MIT — see CREDITS.md.)
 */

export interface LearnedTask {
  id: string;
  /** The request as the user first said it. */
  request: string;
  /** The request with filler words removed: what a new request has to match. */
  key: string;
  steps: ReplayStep[];
  /** What E.V said when it finished. */
  reply: string;
  createdAt: number;
  uses: number;
  lastUsed?: number;
}

const LIMIT = 200;
const MAX_STEPS = 40;

const FILLER = [
  /^(?:hey|hi|ok|okay|yo)\s+/,
  /^(?:e\s?v|evie|eve)\s+/,
  /^(?:can|could|would|will)\s+you\s+(?:please\s+)?/,
  /^please\s+/,
  /\s+(?:please|for me|now|right now|thanks|thank you)$/,
];

/** "Hey E.V, can you open my study setup please?" → "open my study setup". */
export function learnedKey(text: string): string {
  let key = text
    .toLowerCase()
    .replace(/e\.v\.?/g, "ev")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (let changed = true; changed; ) {
    changed = false;
    for (const pattern of FILLER) {
      const next = key.replace(pattern, "").trim();
      if (next !== key) [key, changed] = [next, true];
    }
  }
  return key;
}

export function findLearned(text: string, tasks: LearnedTask[]): LearnedTask | null {
  const key = learnedKey(text);
  return key ? (tasks.find((t) => t.key === key) ?? null) : null;
}

/** Saves (or replaces) the steps for a request. */
export function learnTask(tasks: LearnedTask[], request: string, steps: ReplayStep[], reply: string, id: string, now = Date.now()): LearnedTask[] {
  const key = learnedKey(request);
  if (!key || !steps.length || steps.length > MAX_STEPS) return tasks;
  const same = tasks.find((t) => t.key === key);
  const next: LearnedTask = { id: same?.id ?? id, request, key, steps, reply: reply.trim().slice(0, 600), createdAt: now, uses: same?.uses ?? 0 };
  return [...tasks.filter((t) => t !== same), next].slice(-LIMIT);
}

/** "Forget that shortcut", "delete the learned task". */
export function isForgetRequest(text: string): boolean {
  return /^(?:forget|delete|remove|unlearn|drop) (?:that|this|the|the last|your) (?:shortcut|learned task|saved task|learned shortcut|saved steps)$/.test(learnedKey(text));
}

/**
 * Records a task's actions while the AI works. A task can be learned only if it was nothing but
 * Mac actions, each confirmed by the window, none of which needed the user's approval.
 */
export class Trail {
  private steps: ReplayStep[] | null = [];

  /** A Mac action's result. Reads (look, front) pass through; a failed attempt the AI then redid another way is left out. */
  action(outcome: { ok: boolean; confirmed?: boolean; replay?: ReplayStep[] | null }, approvedByUser: boolean): void {
    if (!this.steps) return;
    if (outcome.replay === undefined) return;
    if (!outcome.ok || outcome.confirmed === false) return;
    if (approvedByUser || outcome.replay === null || outcome.confirmed !== true) {
      this.steps = null;
      return;
    }
    // Opening an address starts the route over in that app: steps before it in the same app were
    // the way that didn't work (guessed pages), so the saved route is only the one that did.
    const first = outcome.replay[0];
    if (first?.tool === "mac_open" && typeof first.args.target === "string" && first.args.target) {
      const app = String(first.args.app ?? "").toLowerCase();
      this.steps = this.steps.filter((s) => String(s.args.app ?? "").toLowerCase() !== app);
    }
    this.steps.push(...outcome.replay);
  }

  /** Anything that isn't a Mac action (a search, a file, a question): the answer needs the AI. */
  other(): void {
    this.steps = null;
  }

  result(): ReplayStep[] | null {
    return this.steps?.some((s) => s.tool !== "wait") ? this.steps : null;
  }
}

export interface ReplayResult {
  ok: boolean;
  /** Card titles of the steps that ran. */
  done: string[];
  /** Why it stopped, when it didn't finish. */
  failure?: string;
}

/** The background never needs the screen for long; a replay that would has to wait is handed to the AI. */
const SCREEN_WAIT_MS = 8_000;
const SCREEN_PAUSE_S = 3;

function replayEnv(): MacEnv {
  return {
    // Learned steps never include sends or deletes; one that turns into one stops the replay.
    confirmFinal: async () => false,
    noteApp: () => {},
    noteUndo: () => {},
    waitForScreen: async () => {
      const until = Date.now() + SCREEN_WAIT_MS;
      while (Date.now() < until) {
        if ((await macUserIdle().catch(() => 0)) >= SCREEN_PAUSE_S) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    },
  };
}

/** Runs saved steps in order, checking each one. */
export async function replay(task: LearnedTask, onStep: (title: string) => void = () => {}): Promise<ReplayResult> {
  const env = replayEnv();
  const done: string[] = [];
  for (const [i, step] of task.steps.entries()) {
    if (step.tool === "wait") {
      await new Promise((r) => setTimeout(r, Math.min(Number(step.args.ms) || 300, 5000)));
      continue;
    }
    const title = describeMacTool(step.tool, step.args);
    const out = await executeMacTool(step.tool, step.args, env);
    if (!out.ok || out.confirmed === false) {
      return { ok: false, done, failure: `step ${i + 1} (${title}): ${out.display || out.output.slice(0, 200)}` };
    }
    done.push(title);
    onStep(title);
    // Give the app a moment to react before the next step, as the AI's batches do.
    await new Promise((r) => setTimeout(r, 120));
  }
  return { ok: true, done };
}
