import { create } from "zustand";
import { uid } from "../lib/ids";
import { vaultLoad, vaultSave } from "../lib/ipc";
import { DEFAULT_RULES, normalizeRules, type Rules } from "../providers/agent/policy";
import type { MemoryItem, MemoryKind, ScheduleItem } from "../types";
import { learn, type Recipe } from "../services/recipes";
import { learnTask, type LearnedTask } from "../services/learned";
import type { ReplayStep } from "../providers/agent/macTools";

/**
 * E.V memory and schedules, decrypted in memory and saved back to the encrypted vault file
 * after every change. Nothing here goes to localStorage.
 */

interface VaultData {
  version: 1;
  memories: MemoryItem[];
  schedule: ScheduleItem[];
  /** Reminder keys already shown, so a restart doesn't repeat them. */
  fired: string[];
  /** "Remember this?" suggestions the user turned down, and receipts already acted on. */
  declined: string[];
  /** What needs approval (Settings → Approvals). Kept here, encrypted, so no AI tool can edit it. */
  rules: Rules;
  /** Everything E.V did on the Mac, newest last. */
  activity: ActivityEntry[];
  /** "Approve always": actions that no longer ask (Settings → Approvals). */
  always: AlwaysRule[];
  /** Connections switched on (Settings → Connections). Anything not listed never runs. */
  connections: string[];
  /** Routes that worked for tasks on the Mac and the web (see services/recipes). */
  recipes: Recipe[];
  /** Tasks E.V repeats with no AI (see services/learned). Kept here because they hold typed text. */
  learned: LearnedTask[];
  /** "kind:app" whose window names keep changing: "Approve always" there ignores the place. */
  looseApps: string[];
}

/** One "Approve always". `key` identifies exactly what it covers (see alwaysKeyFor). */
export interface AlwaysRule {
  key: string;
  label: string;
  createdAt: number;
  uses: number;
  lastUsed?: number;
}

export interface ActivityEntry {
  at: number;
  chat: string;
  tool: string;
  title: string;
  outcome: "done" | "refused" | "denied" | "error" | "ignored";
  detail: string;
}

interface VaultState extends VaultData {
  loaded: boolean;
  error: string | null;
  remember: (input: Omit<MemoryItem, "id" | "createdAt" | "updatedAt">, replaces?: string) => { item: MemoryItem; replaced?: MemoryItem };
  updateMemory: (id: string, patch: Partial<Pick<MemoryItem, "text" | "kind" | "scope" | "chatId" | "chatTitle">>) => void;
  forget: (id: string) => MemoryItem | undefined;
  restore: (item: MemoryItem) => void;
  decline: (stepId: string) => void;
  addEvent: (input: Omit<ScheduleItem, "id" | "createdAt">) => ScheduleItem;
  updateEvent: (id: string, patch: Partial<Omit<ScheduleItem, "id" | "createdAt">>) => ScheduleItem | undefined;
  removeEvent: (id: string) => ScheduleItem | undefined;
  restoreEvent: (item: ScheduleItem) => void;
  markFired: (key: string) => void;
  setRules: (rules: Rules) => void;
  logActivity: (entry: ActivityEntry) => void;
  clearActivity: () => void;
  addAlways: (rule: Omit<AlwaysRule, "createdAt" | "uses">) => void;
  useAlways: (key: string) => void;
  removeAlways: (key: string) => void;
  markLoose: (key: string) => void;
  setConnection: (id: string, on: boolean) => void;
  learnRecipe: (goal: string, steps: string[]) => void;
  useRecipe: (id: string) => void;
  clearRecipes: () => void;
  learnTask: (request: string, steps: ReplayStep[], reply: string) => void;
  useLearned: (id: string) => void;
  forgetLearned: (id: string) => LearnedTask | undefined;
}

const EMPTY: VaultData = { version: 1, memories: [], schedule: [], fired: [], declined: [], rules: DEFAULT_RULES, activity: [], always: [], connections: [], recipes: [], learned: [], looseApps: [] };
const ACTIVITY_LIMIT = 2000;
const KINDS: MemoryKind[] = ["about", "preference", "rule", "lesson", "word", "note"];

export const useVault = create<VaultState>((set, get) => ({
  ...EMPTY,
  loaded: false,
  error: null,

  remember: (input, replaces) => {
    const now = Date.now();
    const replaced = replaces ? get().memories.find((m) => m.id === replaces) : undefined;
    const item: MemoryItem = replaced
      ? { ...replaced, ...input, id: replaced.id, createdAt: replaced.createdAt, updatedAt: now }
      : { ...input, id: uid("mem-"), createdAt: now, updatedAt: now };
    set((s) => ({ memories: replaced ? s.memories.map((m) => (m.id === item.id ? item : m)) : [...s.memories, item] }));
    return { item, replaced };
  },
  updateMemory: (id, patch) =>
    set((s) => ({ memories: s.memories.map((m) => (m.id === id ? { ...m, ...patch, updatedAt: Date.now() } : m)) })),
  forget: (id) => {
    const gone = get().memories.find((m) => m.id === id);
    if (gone) set((s) => ({ memories: s.memories.filter((m) => m.id !== id) }));
    return gone;
  },
  restore: (item) => set((s) => ({ memories: [...s.memories.filter((m) => m.id !== item.id), item] })),
  decline: (stepId) => set((s) => ({ declined: [...s.declined.slice(-500), stepId] })),

  addEvent: (input) => {
    const item: ScheduleItem = { ...input, id: uid("evt-"), createdAt: Date.now() };
    set((s) => ({ schedule: [...s.schedule, item] }));
    return item;
  },
  updateEvent: (id, patch) => {
    const current = get().schedule.find((e) => e.id === id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    set((s) => ({ schedule: s.schedule.map((e) => (e.id === id ? next : e)) }));
    return next;
  },
  removeEvent: (id) => {
    const gone = get().schedule.find((e) => e.id === id);
    if (gone) set((s) => ({ schedule: s.schedule.filter((e) => e.id !== id) }));
    return gone;
  },
  restoreEvent: (item) => set((s) => ({ schedule: [...s.schedule.filter((e) => e.id !== item.id), item] })),
  markFired: (key) => set((s) => ({ fired: [...s.fired.slice(-1000), key] })),
  setRules: (rules) => set({ rules: normalizeRules(rules) }),
  logActivity: (entry) => set((s) => ({ activity: [...s.activity.slice(-(ACTIVITY_LIMIT - 1)), entry] })),
  clearActivity: () => set({ activity: [] }),
  addAlways: (rule) =>
    set((s) => (s.always.some((r) => r.key === rule.key) ? s : { always: [...s.always, { ...rule, createdAt: Date.now(), uses: 0 }] })),
  useAlways: (key) => set((s) => ({ always: s.always.map((r) => (r.key === key ? { ...r, uses: r.uses + 1, lastUsed: Date.now() } : r)) })),
  removeAlways: (key) => set((s) => ({ always: s.always.filter((r) => r.key !== key) })),
  markLoose: (key) => set((s) => (s.looseApps.includes(key) ? s : { looseApps: [...s.looseApps, key] })),
  setConnection: (id, on) =>
    set((s) => ({ connections: on ? [...new Set([...s.connections, id])] : s.connections.filter((c) => c !== id) })),
  learnRecipe: (goal, steps) => set((s) => ({ recipes: learn(s.recipes, goal, steps, uid("route-")) })),
  useRecipe: (id) => set((s) => ({ recipes: s.recipes.map((r) => (r.id === id ? { ...r, uses: r.uses + 1 } : r)) })),
  clearRecipes: () => set({ recipes: [] }),
  learnTask: (request, steps, reply) => set((s) => ({ learned: learnTask(s.learned, request, steps, reply, uid("learned-")) })),
  useLearned: (id) => set((s) => ({ learned: s.learned.map((t) => (t.id === id ? { ...t, uses: t.uses + 1, lastUsed: Date.now() } : t)) })),
  forgetLearned: (id) => {
    const gone = get().learned.find((t) => t.id === id);
    set((s) => ({ learned: s.learned.filter((t) => t.id !== id) }));
    return gone;
  },
}));

/** Accepts whatever the vault held, keeping only well-formed entries. */
export function parseVault(json: string): VaultData {
  if (!json.trim()) return { ...EMPTY };
  const raw = JSON.parse(json) as Partial<VaultData>;
  const memories = (Array.isArray(raw.memories) ? raw.memories : []).filter(
    (m): m is MemoryItem => typeof m?.id === "string" && typeof m.text === "string" && (m.scope === "gideon" || m.scope === "chat"),
  );
  return {
    version: 1,
    memories: memories.map((m) => ({ ...m, kind: KINDS.includes(m.kind) ? m.kind : "note" })),
    schedule: (Array.isArray(raw.schedule) ? raw.schedule : []).filter(
      (e): e is ScheduleItem => typeof e?.id === "string" && typeof e.title === "string" && typeof e.start === "string",
    ),
    fired: Array.isArray(raw.fired) ? raw.fired.filter((f): f is string => typeof f === "string") : [],
    declined: Array.isArray(raw.declined) ? raw.declined.filter((f): f is string => typeof f === "string") : [],
    rules: normalizeRules(raw.rules),
    // "final:" rules were keyed on window titles (song names, page titles) and could never match again.
    always: Array.isArray(raw.always) ? raw.always.filter((a): a is AlwaysRule => typeof a?.key === "string" && typeof a.label === "string" && !a.key.startsWith("final:")) : [],
    activity: Array.isArray(raw.activity) ? raw.activity.filter((a): a is ActivityEntry => typeof a?.at === "number" && typeof a.tool === "string").slice(-ACTIVITY_LIMIT) : [],
    connections: Array.isArray(raw.connections) ? raw.connections.filter((c): c is string => typeof c === "string") : [],
    recipes: Array.isArray(raw.recipes)
      ? raw.recipes.filter((r): r is Recipe => typeof r?.id === "string" && typeof r.goal === "string" && Array.isArray(r.steps)).map((r) => ({ ...r, steps: r.steps.filter((x) => typeof x === "string") }))
      : [],
    learned: Array.isArray(raw.learned)
      ? raw.learned
          .filter((t): t is LearnedTask => typeof t?.id === "string" && typeof t.key === "string" && typeof t.request === "string" && Array.isArray(t.steps))
          .map((t) => ({ ...t, steps: t.steps.filter((s) => typeof s?.tool === "string" && s.args && typeof s.args === "object") }))
      : [],
    looseApps: Array.isArray(raw.looseApps) ? raw.looseApps.filter((k): k is string => typeof k === "string") : [],
  };
}

let saveTimer: number | null = null;
let started = false;

/** Loads the vault once and saves it (debounced) whenever it changes. */
export async function startVault(): Promise<void> {
  if (started) return;
  started = true;
  try {
    useVault.setState({ ...parseVault(await vaultLoad()), loaded: true, error: null });
  } catch (err) {
    // Never save over a vault we couldn't open: that would wipe the user's memory.
    useVault.setState({ loaded: false, error: String(err) });
    return;
  }
  useVault.subscribe((state, previous) => {
    if (!state.loaded) return;
    if (
      state.memories === previous.memories &&
      state.schedule === previous.schedule &&
      state.fired === previous.fired &&
      state.declined === previous.declined &&
      state.rules === previous.rules &&
      state.activity === previous.activity &&
      state.always === previous.always &&
      state.connections === previous.connections &&
      state.recipes === previous.recipes &&
      state.learned === previous.learned &&
      state.looseApps === previous.looseApps
    )
      return;
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      const { version, memories, schedule, fired, declined, rules, activity, always, connections, recipes, learned, looseApps } = useVault.getState();
      void vaultSave(JSON.stringify({ version, memories, schedule, fired, declined, rules, activity, always, connections, recipes, learned, looseApps })).catch((err) =>
        useVault.setState({ error: `Couldn't save memory: ${String(err)}` }),
      );
    }, 400);
  });
}

/** Removes chat memories whose chat no longer exists (deleting a chat deletes its memory). */
export function pruneChatMemories(liveChatIds: Set<string>): void {
  const { memories, loaded } = useVault.getState();
  if (!loaded) return;
  const kept = memories.filter((m) => m.scope !== "chat" || (m.chatId && liveChatIds.has(m.chatId)));
  if (kept.length !== memories.length) useVault.setState({ memories: kept });
}
