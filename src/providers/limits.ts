import type { KeyedProviderId } from "../types";

/** Non-2xx provider response, carrying what the key engine needs to classify it. */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body = "",
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

/** What a failed attempt means for the key that made it. */
export type Failure =
  /** Short rate limit (per minute) or provider overload: rest the key briefly. */
  | { kind: "cooling"; until: number }
  /** Daily quota used up: skip the key until the quota refills. */
  | { kind: "exhausted"; until: number; limit?: number }
  /** The model is not part of this key's plan (free-tier limit 0). */
  | { kind: "unavailable"; until: number }
  /** The provider rejected the key itself. */
  | { kind: "invalid"; reason: string }
  /** Not key related (bad request, unknown model): surface the error as is. */
  | { kind: "fatal" };

/** Usage the provider reported in its response headers (Groq). */
export interface ReportedUsage {
  limit: number;
  remaining: number;
  resetAt: number;
}

export const SHORT_COOLDOWN_MS = 60_000;
export const OVERLOAD_COOLDOWN_MS = 15_000;

const pacificParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function pacific(now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of pacificParts.formatToParts(now)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return out;
}

/** Calendar day in Pacific time — the day Gemini's daily quotas are counted in. */
export function pacificDay(now: number): string {
  const p = pacific(now);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Next midnight Pacific time, when Gemini's requests-per-day quotas reset. */
export function nextPacificMidnight(now: number): number {
  const p = pacific(now);
  const sinceMidnight = (p.hour * 3600 + p.minute * 60 + p.second) * 1000 + (now % 1000);
  return now - sinceMidnight + 86_400_000;
}

/** Parses provider durations such as "75015s", "2m59.56s", "1h2m3.5s" or "7.66s" into ms. */
export function parseDuration(text: string | undefined): number | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(trimmed);
  if (!match || trimmed === "") return null;
  const [, h, m, s, ms] = match;
  return Math.round(
    Number(h ?? 0) * 3_600_000 + Number(m ?? 0) * 60_000 + Number(s ?? 0) * 1000 + Number(ms ?? 0),
  );
}

interface GeminiErrorBody {
  error?: {
    message?: string;
    status?: string;
    details?: { "@type"?: string; violations?: { quotaId?: string }[]; retryDelay?: string; reason?: string }[];
  };
}

function parseGeminiError(body: string): GeminiErrorBody["error"] | undefined {
  try {
    const parsed = JSON.parse(body) as GeminiErrorBody | GeminiErrorBody[];
    return (Array.isArray(parsed) ? parsed[0] : parsed)?.error;
  } catch {
    return undefined;
  }
}

function classifyGemini(err: HttpStatusError, now: number): Failure {
  const error = parseGeminiError(err.body);
  const message = error?.message ?? err.body;
  const details = error?.details ?? [];

  if (err.status === 429) {
    const quotaIds = details.flatMap((d) => d.violations ?? []).map((v) => v.quotaId ?? "");
    const retryMs = parseDuration(details.find((d) => d.retryDelay)?.retryDelay);
    const limits = [...message.matchAll(/limit:\s*(\d+)/g)].map((m) => Number(m[1]));
    const daily = quotaIds.some((id) => /PerDay/i.test(id));
    if (limits.length > 0 && limits.every((l) => l === 0)) {
      return { kind: "unavailable", until: nextPacificMidnight(now) };
    }
    if (daily) {
      const requestLimit = limits.find((l) => l > 0);
      return { kind: "exhausted", until: retryMs ? now + retryMs : nextPacificMidnight(now), limit: requestLimit };
    }
    return { kind: "cooling", until: now + (retryMs ?? SHORT_COOLDOWN_MS) };
  }
  if (err.status === 401 || err.status === 403 || (err.status === 400 && /api key/i.test(message))) {
    return { kind: "invalid", reason: message.slice(0, 160) };
  }
  if (err.status === 500 || err.status === 503 || err.status === 504) {
    return { kind: "cooling", until: now + OVERLOAD_COOLDOWN_MS };
  }
  return { kind: "fatal" };
}

function classifyGroq(err: HttpStatusError, now: number): Failure {
  const h = err.headers;
  if (err.status === 429) {
    const reported = readReportedUsage("groq", h, now);
    if (reported && reported.remaining <= 0) return { kind: "exhausted", until: reported.resetAt };
    const retryMs = parseDuration(h["retry-after"]);
    return { kind: "cooling", until: now + (retryMs ?? SHORT_COOLDOWN_MS) };
  }
  if (err.status === 401 || err.status === 403) return { kind: "invalid", reason: err.message.slice(0, 160) };
  if (err.status >= 500) return { kind: "cooling", until: now + OVERLOAD_COOLDOWN_MS };
  return { kind: "fatal" };
}

export function classifyFailure(provider: KeyedProviderId, err: HttpStatusError, now: number): Failure {
  return provider === "gemini" ? classifyGemini(err, now) : classifyGroq(err, now);
}

/** Groq reports its requests-per-day budget on every response; Gemini reports nothing. */
export function readReportedUsage(
  provider: KeyedProviderId,
  headers: Record<string, string>,
  now: number,
): ReportedUsage | null {
  if (provider !== "groq") return null;
  const limit = Number(headers["x-ratelimit-limit-requests"]);
  const remaining = Number(headers["x-ratelimit-remaining-requests"]);
  const resetMs = parseDuration(headers["x-ratelimit-reset-requests"]);
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0) return null;
  return { limit, remaining, resetAt: now + (resetMs ?? 0) };
}
