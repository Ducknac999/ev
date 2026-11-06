import type { ApiKey, KeyedProviderId } from "../types";
import { KEYED_PROVIDERS as ALL_KEYED } from "./catalog";
import { freeDailyEstimate, PROVIDERS } from "./catalog";
import {
  classifyFailure,
  HttpStatusError,
  nextPacificMidnight,
  pacificDay,
  readReportedUsage,
  type ReportedUsage,
} from "./limits";

export { HttpStatusError } from "./limits";

export type KeyStatus = "in-use" | "ready" | "cooling" | "exhausted" | "unavailable" | "invalid";
export type LimitSource = "reported" | "learned" | "set" | "estimate";

/** Everything the UI shows for one key on one model. */
export interface KeyView {
  id: string;
  name: string;
  status: KeyStatus;
  /** Chats currently streaming on this key. */
  usedBy: string[];
  /** When a cooling/exhausted/unavailable key becomes usable again. */
  until: number | null;
  reason?: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  /** When the daily budget refills. */
  resetAt: number | null;
  limitSource: LimitSource | null;
}

export interface UsageTotals {
  used: number;
  limit: number | null;
  remaining: number | null;
  usable: number;
  total: number;
}

export class NoKeysError extends Error {
  constructor(
    readonly provider: KeyedProviderId,
    message: string,
    /** Epoch ms when the earliest blocked key becomes usable, or null when none will. */
    readonly retryAt: number | null,
  ) {
    super(message);
    this.name = "NoKeysError";
  }
}

interface ModelState {
  /** Pacific-time day the request counter belongs to. */
  day: string;
  requests: number;
  coolingUntil?: number;
  exhaustedUntil?: number;
  unavailableUntil?: number;
  reported?: ReportedUsage;
}

interface KeyRuntime {
  /** Fingerprint of the secret, so editing a key's value resets its health. */
  fp: string;
  invalid?: string;
  models: Record<string, ModelState>;
}

interface PersistedUsage {
  keys: Record<string, KeyRuntime>;
  /** Daily limits Google revealed in 429 responses (provider → model → requests per day). */
  learned: Partial<Record<KeyedProviderId, Record<string, number>>>;
}

export interface Recovery {
  provider: KeyedProviderId;
  keyName: string;
  model: string;
}

export interface KeySwitch {
  from: ApiKey;
  to: ApiKey;
  reason: KeyStatus;
}

export interface ExecuteOptions {
  provider: KeyedProviderId;
  model: string;
  chatId: string;
  /** Key the user picked by hand; used whenever it is healthy, even if another chat shares it. */
  pinnedKeyId?: string;
  /** Key the chat used last time; preferred when no other chat holds it. */
  preferredKeyId?: string;
  onKey?: (key: ApiKey) => void;
  onSwitch?: (change: KeySwitch) => void;
}

type Listener = () => void;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const STORAGE_KEY = "gideon.keyUsage";

const fingerprint = (secret: string) => `${secret.length}:${secret.slice(-6)}`;

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

function defaultStorage(): Storage {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    /* storage blocked */
  }
  return memoryStorage();
}

/**
 * Leases API keys to chats. Each answering chat holds its own key so parallel chats never share
 * a quota when a free key exists; a key that hits a limit is skipped (for that model) until it
 * recovers and the request moves to the next free key. Usage is persisted across restarts.
 */
export class KeyLeaseEngine {
  private keys = Object.fromEntries(ALL_KEYED.map((p) => [p, [] as ApiKey[]])) as Record<KeyedProviderId, ApiKey[]>;
  private dailyLimits = Object.fromEntries(ALL_KEYED.map((p) => [p, {} as Record<string, number>])) as Record<KeyedProviderId, Record<string, number>>;
  private leases = new Map<string, Set<string>>();
  private state: PersistedUsage;
  private listeners = new Set<Listener>();
  private recoveryListeners = new Set<(r: Recovery) => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly storage: Storage = defaultStorage(),
  ) {
    this.state = this.load();
  }

  configure(provider: KeyedProviderId, keys: ApiKey[], dailyLimits: Record<string, number> = {}): void {
    this.keys[provider] = keys.filter((k) => k.key.trim());
    this.dailyLimits[provider] = dailyLimits;
    for (const key of this.keys[provider]) {
      const runtime = this.state.keys[key.id];
      if (!runtime || runtime.fp !== fingerprint(key.key)) {
        this.state.keys[key.id] = { fp: fingerprint(key.key), models: {} };
      }
    }
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onRecover(listener: (r: Recovery) => void): () => void {
    this.recoveryListeners.add(listener);
    return () => this.recoveryListeners.delete(listener);
  }

  keysFor(provider: KeyedProviderId): ApiKey[] {
    return this.keys[provider];
  }

  /** The key a chat is streaming on right now, if any. */
  activeKeyFor(chatId: string): ApiKey | null {
    for (const provider of Object.keys(this.keys) as KeyedProviderId[]) {
      const key = this.keys[provider].find((k) => this.leases.get(k.id)?.has(chatId));
      if (key) return key;
    }
    return null;
  }

  view(provider: KeyedProviderId, model: string): KeyView[] {
    const now = this.clock();
    return this.keys[provider].map((key) => this.viewKey(provider, key, model, now));
  }

  totals(provider: KeyedProviderId, model: string): UsageTotals {
    const views = this.view(provider, model);
    const usable = views.filter((v) => v.status === "ready" || v.status === "in-use");
    const known = views.filter((v) => v.limit !== null && v.status !== "invalid" && v.status !== "unavailable");
    const limit = known.length ? known.reduce((sum, v) => sum + (v.limit ?? 0), 0) : null;
    const remaining = known.length ? known.reduce((sum, v) => sum + (v.remaining ?? 0), 0) : null;
    return {
      used: views.reduce((sum, v) => sum + v.used, 0),
      limit,
      remaining,
      usable: usable.length,
      total: views.length,
    };
  }

  /**
   * Runs `attempt` on a leased key, moving to the next suitable key when the provider reports a
   * limit. `attempt` resolves with the response headers. Returns the key that succeeded.
   */
  async execute(
    options: ExecuteOptions,
    attempt: (key: ApiKey) => Promise<Record<string, string>>,
  ): Promise<ApiKey> {
    const { provider, model, chatId } = options;
    const tried = new Set<string>();
    let previous: ApiKey | null = null;
    let lastFailure: KeyStatus = "cooling";

    for (;;) {
      const key = this.choose(options, tried);
      if (!key) throw this.noKeysError(provider, model);
      tried.add(key.id);
      if (previous) options.onSwitch?.({ from: previous, to: key, reason: lastFailure });
      options.onKey?.(key);
      this.lease(key.id, chatId);

      try {
        const headers = await attempt(key);
        this.recordRequest(key.id, model, readReportedUsage(provider, headers, this.clock()));
        return key;
      } catch (err) {
        if (!(err instanceof HttpStatusError)) {
          // Aborted or dropped mid-stream: the request still reached the provider.
          this.recordRequest(key.id, model, null);
          throw err;
        }
        const failure = classifyFailure(provider, err, this.clock());
        if (failure.kind === "fatal") throw err;
        this.applyFailure(provider, key.id, model, failure, err.headers);
        lastFailure = failure.kind === "invalid" ? "invalid" : failure.kind;
        previous = key;
      } finally {
        this.release(key.id, chatId);
      }
    }
  }

  /** Clears expired blocks and announces keys that are usable again. Call periodically. */
  tick(): void {
    const now = this.clock();
    let changed = false;
    for (const provider of Object.keys(this.keys) as KeyedProviderId[]) {
      for (const key of this.keys[provider]) {
        const runtime = this.state.keys[key.id];
        if (!runtime) continue;
        for (const [model, m] of Object.entries(runtime.models)) {
          if (m.exhaustedUntil !== undefined && m.exhaustedUntil <= now) {
            delete m.exhaustedUntil;
            m.requests = 0;
            m.day = pacificDay(now);
            delete m.reported;
            changed = true;
            for (const listener of this.recoveryListeners) listener({ provider, keyName: key.name, model });
          }
          if (m.coolingUntil !== undefined && m.coolingUntil <= now) {
            delete m.coolingUntil;
            changed = true;
          }
          if (m.unavailableUntil !== undefined && m.unavailableUntil <= now) {
            delete m.unavailableUntil;
            changed = true;
          }
        }
      }
    }
    if (changed) this.emit();
  }

  private choose(options: ExecuteOptions, tried: Set<string>): ApiKey | null {
    const { provider, model, chatId, pinnedKeyId, preferredKeyId } = options;
    const now = this.clock();
    const candidates = this.keys[provider].filter((k) => !tried.has(k.id) && this.isUsable(k.id, model, now));
    if (candidates.length === 0) return null;

    const pinned = candidates.find((k) => k.id === pinnedKeyId);
    if (pinned) return pinned;

    const othersOn = (k: ApiKey) => [...(this.leases.get(k.id) ?? [])].filter((c) => c !== chatId).length;
    const headroom = (k: ApiKey) => {
      const v = this.viewKey(provider, k, model, now);
      return v.remaining ?? Number.MAX_SAFE_INTEGER - v.used;
    };

    const free = candidates.filter((k) => othersOn(k) === 0);
    if (free.length > 0) {
      const preferred = free.find((k) => k.id === preferredKeyId);
      if (preferred) return preferred;
      return free.reduce((best, k) => (headroom(k) > headroom(best) ? k : best));
    }
    // Every usable key is busy: share the least crowded one rather than waiting.
    return candidates.reduce((best, k) => {
      const diff = othersOn(k) - othersOn(best);
      return diff < 0 || (diff === 0 && headroom(k) > headroom(best)) ? k : best;
    });
  }

  private isUsable(keyId: string, model: string, now: number): boolean {
    const runtime = this.state.keys[keyId];
    if (!runtime) return true;
    if (runtime.invalid) return false;
    const m = runtime.models[model];
    if (!m) return true;
    return !(
      (m.coolingUntil ?? 0) > now ||
      (m.exhaustedUntil ?? 0) > now ||
      (m.unavailableUntil ?? 0) > now
    );
  }

  private modelState(keyId: string, model: string, now: number): ModelState {
    const runtime = (this.state.keys[keyId] ??= { fp: "", models: {} });
    const day = pacificDay(now);
    const m = (runtime.models[model] ??= { day, requests: 0 });
    if (m.day !== day) {
      m.day = day;
      m.requests = 0;
    }
    return m;
  }

  private recordRequest(keyId: string, model: string, reported: ReportedUsage | null): void {
    const m = this.modelState(keyId, model, this.clock());
    m.requests += 1;
    if (reported) m.reported = reported;
    this.emit();
  }

  private applyFailure(
    provider: KeyedProviderId,
    keyId: string,
    model: string,
    failure: Exclude<ReturnType<typeof classifyFailure>, { kind: "fatal" }>,
    headers: Record<string, string>,
  ): void {
    const now = this.clock();
    const m = this.modelState(keyId, model, now);
    switch (failure.kind) {
      case "cooling":
        m.coolingUntil = failure.until;
        break;
      case "exhausted": {
        m.exhaustedUntil = failure.until;
        if (failure.limit) {
          (this.state.learned[provider] ??= {})[model] = failure.limit;
        }
        const reported = readReportedUsage(provider, headers, now);
        if (reported) m.reported = reported;
        break;
      }
      case "unavailable":
        m.unavailableUntil = failure.until;
        break;
      case "invalid":
        this.state.keys[keyId].invalid = failure.reason;
        break;
    }
    this.emit();
  }

  /** Effective requests-per-day limit for a model and where the number came from. */
  dailyLimit(provider: KeyedProviderId, model: string): { limit: number; source: LimitSource } | null {
    const learned = this.state.learned[provider]?.[model];
    if (learned) return { limit: learned, source: "learned" };
    const set = this.dailyLimits[provider][model];
    if (set && set > 0) return { limit: set, source: "set" };
    const estimate = freeDailyEstimate(provider, model);
    if (estimate !== undefined && estimate > 0) return { limit: estimate, source: "estimate" };
    return null;
  }

  private viewKey(provider: KeyedProviderId, key: ApiKey, model: string, now: number): KeyView {
    const runtime = this.state.keys[key.id];
    const raw = runtime?.models[model];
    const sameDay = raw && raw.day === pacificDay(now);
    const requests = sameDay ? raw.requests : 0;
    const usedBy = [...(this.leases.get(key.id) ?? [])];

    let status: KeyStatus = usedBy.length > 0 ? "in-use" : "ready";
    let until: number | null = null;
    if (runtime?.invalid) status = "invalid";
    else if ((raw?.unavailableUntil ?? 0) > now) [status, until] = ["unavailable", raw!.unavailableUntil!];
    else if ((raw?.exhaustedUntil ?? 0) > now) [status, until] = ["exhausted", raw!.exhaustedUntil!];
    else if ((raw?.coolingUntil ?? 0) > now) [status, until] = ["cooling", raw!.coolingUntil!];

    const base = {
      id: key.id,
      name: key.name,
      status,
      usedBy,
      until,
      reason: runtime?.invalid,
    };

    if (provider === "groq") {
      const reported = raw?.reported;
      if (reported) {
        const fresh = reported.resetAt > now;
        const remaining = status === "exhausted" ? 0 : fresh ? reported.remaining : reported.limit;
        return {
          ...base,
          used: reported.limit - remaining,
          limit: reported.limit,
          remaining,
          resetAt: fresh ? reported.resetAt : null,
          limitSource: "reported",
        };
      }
      return { ...base, used: requests, limit: null, remaining: null, resetAt: null, limitSource: null };
    }

    const resetAt = nextPacificMidnight(now);
    if (status === "unavailable") {
      return { ...base, used: 0, limit: 0, remaining: 0, resetAt, limitSource: "learned" };
    }
    const known = this.dailyLimit(provider, model);
    if (!known) return { ...base, used: requests, limit: null, remaining: null, resetAt, limitSource: null };
    const used = status === "exhausted" ? Math.max(requests, known.limit) : Math.min(requests, known.limit);
    return {
      ...base,
      used,
      limit: known.limit,
      remaining: Math.max(0, known.limit - used),
      resetAt,
      limitSource: known.source,
    };
  }

  private noKeysError(provider: KeyedProviderId, model: string): NoKeysError {
    const label = PROVIDERS[provider].label;
    const views = this.view(provider, model);
    if (views.length === 0) {
      return new NoKeysError(provider, `No ${label} API keys configured. Add keys in Settings.`, null);
    }
    if (views.every((v) => v.status === "invalid")) {
      return new NoKeysError(provider, `Every ${label} key was rejected. Check the keys in Settings.`, null);
    }
    if (views.every((v) => v.status === "invalid" || v.status === "unavailable")) {
      return new NoKeysError(
        provider,
        `${model} is not available on the free tier for any of your ${label} keys. Pick another model.`,
        null,
      );
    }
    const waits = views.map((v) => v.until).filter((u): u is number => u !== null);
    const retryAt = waits.length ? Math.min(...waits) : null;
    const exhausted = views.filter((v) => v.status === "exhausted").length;
    const when =
      retryAt === null
        ? ""
        : retryAt - this.clock() < 120_000
          ? ` Next key frees up in ${Math.max(1, Math.ceil((retryAt - this.clock()) / 1000))}s.`
          : ` Next key frees up at ${new Date(retryAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
    const what = exhausted === views.length ? "have used up today's limit" : "are rate limited right now";
    return new NoKeysError(provider, `All ${views.length} ${label} keys ${what} for ${model}.${when}`, retryAt);
  }

  private lease(keyId: string, chatId: string): void {
    const set = this.leases.get(keyId) ?? new Set<string>();
    set.add(chatId);
    this.leases.set(keyId, set);
    this.emit();
  }

  private release(keyId: string, chatId: string): void {
    const set = this.leases.get(keyId);
    if (!set) return;
    set.delete(chatId);
    if (set.size === 0) this.leases.delete(keyId);
    this.emit();
  }

  private load(): PersistedUsage {
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedUsage>;
        return { keys: parsed.keys ?? {}, learned: parsed.learned ?? {} };
      }
    } catch {
      /* corrupt or blocked storage: start fresh */
    }
    return { keys: {}, learned: {} };
  }

  private persist(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        this.storage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      } catch {
        /* storage full or blocked: usage simply won't survive a restart */
      }
    }, 250);
  }

  private emit(): void {
    this.persist();
    for (const listener of this.listeners) listener();
  }
}

export const keyEngine = new KeyLeaseEngine();
