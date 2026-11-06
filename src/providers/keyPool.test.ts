import { describe, expect, it } from "vitest";
import type { ApiKey } from "../types";
import { KeyLeaseEngine, NoKeysError } from "./keyPool";
import { classifyFailure, HttpStatusError, nextPacificMidnight, pacificDay, parseDuration } from "./limits";

const FLASH = "gemini-3.5-flash";
const LITE = "gemini-3.5-flash-lite";
// 2026-10-08 10:00 Pacific (17:00 UTC, PDT).
const T0 = Date.UTC(2026, 9, 8, 17, 0, 0);

const keys = (...names: string[]): ApiKey[] => names.map((n) => ({ id: n, name: n, key: `secret-${n}` }));

function memory() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

function engineAt(start = T0) {
  const clock = { now: start };
  const storage = memory();
  const engine = new KeyLeaseEngine(() => clock.now, storage);
  return { engine, clock, storage };
}

function geminiQuota429(opts: { daily: boolean; limit: number; retry: string }): HttpStatusError {
  const body = JSON.stringify({
    error: {
      code: 429,
      message: `You exceeded your current quota.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: ${opts.limit}, model: gemini-3.5-flash\nPlease retry in ${opts.retry}.`,
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [
            {
              quotaId: opts.daily
                ? "GenerateRequestsPerDayPerProjectPerModel-FreeTier"
                : "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
            },
          ],
        },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: opts.retry },
      ],
    },
  });
  return new HttpStatusError(429, "HTTP 429: quota", body, {});
}

/** A request that stays open until `finish` is called, so leases can be observed. */
function pending() {
  let finish!: () => void;
  const done = new Promise<Record<string, string>>((resolve) => (finish = () => resolve({})));
  return { done, finish };
}

describe("limits", () => {
  it("parses provider durations", () => {
    expect(parseDuration("75015s")).toBe(75_015_000);
    expect(parseDuration("2m59.56s")).toBe(179_560);
    expect(parseDuration("1h2m3s")).toBe(3_723_000);
    expect(parseDuration("7.66s")).toBe(7_660);
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration("2")).toBe(2_000);
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("soon")).toBeNull();
  });

  it("tracks the Pacific-time day and its midnight", () => {
    expect(pacificDay(T0)).toBe("2026-10-08");
    expect(nextPacificMidnight(T0)).toBe(Date.UTC(2026, 9, 9, 7, 0, 0));
  });

  it("classifies Gemini responses", () => {
    expect(classifyFailure("gemini", geminiQuota429({ daily: true, limit: 250, retry: "3600s" }), T0)).toEqual({
      kind: "exhausted",
      until: T0 + 3_600_000,
      limit: 250,
    });
    expect(classifyFailure("gemini", geminiQuota429({ daily: false, limit: 10, retry: "41s" }), T0)).toEqual({
      kind: "cooling",
      until: T0 + 41_000,
    });
    expect(classifyFailure("gemini", geminiQuota429({ daily: true, limit: 0, retry: "75015s" }), T0).kind).toBe(
      "unavailable",
    );
    const badKey = new HttpStatusError(400, "x", JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key." } }));
    expect(classifyFailure("gemini", badKey, T0).kind).toBe("invalid");
    expect(classifyFailure("gemini", new HttpStatusError(503, "busy"), T0).kind).toBe("cooling");
    expect(classifyFailure("gemini", new HttpStatusError(404, "no such model"), T0).kind).toBe("fatal");
  });

  it("classifies Groq responses from their headers", () => {
    const daily = new HttpStatusError(429, "x", "", {
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-reset-requests": "2h0m0s",
    });
    expect(classifyFailure("groq", daily, T0)).toEqual({ kind: "exhausted", until: T0 + 7_200_000 });
    const minute = new HttpStatusError(429, "x", "", { "retry-after": "7", "x-ratelimit-remaining-requests": "900", "x-ratelimit-limit-requests": "1000" });
    expect(classifyFailure("groq", minute, T0)).toEqual({ kind: "cooling", until: T0 + 7_000 });
    expect(classifyFailure("groq", new HttpStatusError(401, "bad"), T0).kind).toBe("invalid");
  });
});

describe("KeyLeaseEngine", () => {
  it("gives parallel chats different keys", async () => {
    const { engine } = engineAt();
    engine.configure("gemini", keys("g1", "g2", "g3"));
    const a = pending();
    const b = pending();
    const used: Record<string, string> = {};
    const runA = engine.execute({ provider: "gemini", model: FLASH, chatId: "c1" }, (k) => ((used.c1 = k.id), a.done));
    const runB = engine.execute({ provider: "gemini", model: FLASH, chatId: "c2" }, (k) => ((used.c2 = k.id), b.done));
    expect(used.c1).not.toBe(used.c2);
    expect(engine.activeKeyFor("c1")?.id).toBe(used.c1);
    const inUse = engine.view("gemini", FLASH).filter((v) => v.status === "in-use");
    expect(inUse.map((v) => v.usedBy)).toEqual(expect.arrayContaining([["c1"], ["c2"]]));
    a.finish();
    b.finish();
    await Promise.all([runA, runB]);
    expect(engine.activeKeyFor("c1")).toBeNull();
  });

  it("moves a limited chat to a key no other chat is using", async () => {
    const { engine } = engineAt();
    engine.configure("gemini", keys("g1", "g2", "g3", "g4"));
    const holds = [pending(), pending()];
    const runs = ["c1", "c2"].map((chatId, i) =>
      engine.execute({ provider: "gemini", model: FLASH, chatId, preferredKeyId: `g${i + 1}` }, () => holds[i].done),
    );
    const switches: string[] = [];
    const tried: string[] = [];
    const winner = await engine.execute(
      { provider: "gemini", model: FLASH, chatId: "c3", preferredKeyId: "g3", onSwitch: (s) => switches.push(`${s.from.id}->${s.to.id}:${s.reason}`) },
      async (k) => {
        tried.push(k.id);
        if (k.id === "g3") throw geminiQuota429({ daily: true, limit: 250, retry: "3600s" });
        return {};
      },
    );
    expect(tried).toEqual(["g3", "g4"]);
    expect(winner.id).toBe("g4");
    expect(switches).toEqual(["g3->g4:exhausted"]);
    const g3 = engine.view("gemini", FLASH).find((v) => v.id === "g3")!;
    expect(g3.status).toBe("exhausted");
    expect(g3.remaining).toBe(0);
    expect(engine.dailyLimit("gemini", FLASH)).toEqual({ limit: 250, source: "learned" });
    holds.forEach((h) => h.finish());
    await Promise.all(runs);
  });

  it("limits are per model: a key used up on Flash still serves Flash-Lite", async () => {
    const { engine } = engineAt();
    engine.configure("gemini", keys("g1"));
    await expect(
      engine.execute({ provider: "gemini", model: FLASH, chatId: "c1" }, async () => {
        throw geminiQuota429({ daily: true, limit: 250, retry: "3600s" });
      }),
    ).rejects.toBeInstanceOf(NoKeysError);
    const used = await engine.execute({ provider: "gemini", model: LITE, chatId: "c1" }, async () => ({}));
    expect(used.id).toBe("g1");
  });

  it("honours a pinned key even when another chat shares it, and falls back when it runs out", async () => {
    const { engine } = engineAt();
    engine.configure("gemini", keys("g1", "g2"));
    const hold = pending();
    const run = engine.execute({ provider: "gemini", model: FLASH, chatId: "c1", pinnedKeyId: "g1" }, () => hold.done);
    const shared = await engine.execute({ provider: "gemini", model: FLASH, chatId: "c2", pinnedKeyId: "g1" }, async () => ({}));
    expect(shared.id).toBe("g1");
    hold.finish();
    await run;

    const fallback = await engine.execute({ provider: "gemini", model: FLASH, chatId: "c1", pinnedKeyId: "g1" }, async (k) => {
      if (k.id === "g1") throw geminiQuota429({ daily: true, limit: 250, retry: "3600s" });
      return {};
    });
    expect(fallback.id).toBe("g2");
  });

  it("reuses the chat's previous key when it is free", async () => {
    const { engine } = engineAt();
    engine.configure("gemini", keys("g1", "g2", "g3"));
    const first = await engine.execute({ provider: "gemini", model: FLASH, chatId: "c1", preferredKeyId: "g2" }, async () => ({}));
    expect(first.id).toBe("g2");
  });

  it("shares the least crowded key when every key is busy instead of failing", async () => {
    const { engine } = engineAt();
    engine.configure("groq", keys("q1", "q2"));
    const holds = [pending(), pending(), pending()];
    const runs = ["c1", "c2", "c3"].map((chatId, i) =>
      engine.execute({ provider: "groq", model: "llama-3.3-70b-versatile", chatId }, () => holds[i].done),
    );
    const crowd = engine.view("groq", "llama-3.3-70b-versatile").map((v) => v.usedBy.length).sort();
    expect(crowd).toEqual([1, 2]);
    holds.forEach((h) => h.finish());
    await Promise.all(runs);
  });

  it("counts requests per day and refills at Pacific midnight, announcing exhausted keys", async () => {
    const { engine, clock } = engineAt();
    engine.configure("gemini", keys("g1", "g2"), { [FLASH]: 100 });
    for (let i = 0; i < 3; i++) await engine.execute({ provider: "gemini", model: FLASH, chatId: "c1", pinnedKeyId: "g1" }, async () => ({}));
    let g1 = engine.view("gemini", FLASH).find((v) => v.id === "g1")!;
    expect([g1.used, g1.limit, g1.remaining, g1.limitSource]).toEqual([3, 100, 97, "set"]);
    expect(engine.totals("gemini", FLASH)).toMatchObject({ used: 3, limit: 200, remaining: 197, usable: 2, total: 2 });

    await engine
      .execute({ provider: "gemini", model: FLASH, chatId: "c1", pinnedKeyId: "g2" }, async (k) => {
        if (k.id === "g2") throw geminiQuota429({ daily: true, limit: 100, retry: `${(nextPacificMidnight(clock.now) - clock.now) / 1000}s` });
        return {};
      })
      .catch(() => undefined);

    const recovered: string[] = [];
    engine.onRecover((r) => recovered.push(`${r.keyName}:${r.model}`));
    clock.now = nextPacificMidnight(T0) + 1_000;
    engine.tick();
    expect(recovered).toEqual([`g2:${FLASH}`]);
    g1 = engine.view("gemini", FLASH).find((v) => v.id === "g1")!;
    expect(g1.used).toBe(0);
    expect(engine.view("gemini", FLASH).every((v) => v.status === "ready")).toBe(true);
  });

  it("uses Groq's reported numbers for the bar", async () => {
    const { engine } = engineAt();
    engine.configure("groq", keys("q1"));
    await engine.execute({ provider: "groq", model: "llama-3.3-70b-versatile", chatId: "c1" }, async () => ({
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-remaining-requests": "640",
      "x-ratelimit-reset-requests": "5h12m0s",
    }));
    const q1 = engine.view("groq", "llama-3.3-70b-versatile")[0];
    expect([q1.used, q1.limit, q1.remaining, q1.limitSource]).toEqual([360, 1000, 640, "reported"]);
    expect(q1.resetAt).toBe(T0 + (5 * 60 + 12) * 60_000);
  });

  it("skips rejected keys and explains when nothing is left", async () => {
    const { engine } = engineAt();
    engine.configure("gemini", keys("g1", "g2"));
    const error = await engine
      .execute({ provider: "gemini", model: FLASH, chatId: "c1" }, async () => {
        throw new HttpStatusError(403, "denied", "{}");
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(NoKeysError);
    expect(error.message).toMatch(/rejected/);
    expect(engine.view("gemini", FLASH).every((v) => v.status === "invalid")).toBe(true);

    // Editing a key's secret clears its rejected state.
    engine.configure("gemini", [{ id: "g1", name: "g1", key: "fresh-secret" }, ...keys("g2")]);
    expect(engine.view("gemini", FLASH).find((v) => v.id === "g1")!.status).toBe("ready");
  });

  it("reports when the first used-up key comes back", async () => {
    const { engine } = engineAt();
    engine.configure("gemini", keys("g1", "g2"));
    const error = await engine
      .execute({ provider: "gemini", model: FLASH, chatId: "c1" }, async (k) => {
        throw geminiQuota429({ daily: true, limit: 250, retry: k.id === "g1" ? "600s" : "900s" });
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(NoKeysError);
    expect(error.retryAt).toBe(T0 + 600_000);
    expect(error.message).toMatch(/All 2 Gemini keys have used up today's limit/);
  });

  it("surfaces non-key errors without burning other keys", async () => {
    const { engine } = engineAt();
    engine.configure("gemini", keys("g1", "g2"));
    const tried: string[] = [];
    await expect(
      engine.execute({ provider: "gemini", model: "gemini-2.5-flash", chatId: "c1" }, async (k) => {
        tried.push(k.id);
        throw new HttpStatusError(404, "HTTP 404: no longer available");
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(tried).toHaveLength(1);
  });

  it("keeps usage across restarts", async () => {
    const { engine, clock, storage } = engineAt();
    engine.configure("gemini", keys("g1"));
    await engine.execute({ provider: "gemini", model: FLASH, chatId: "c1" }, async () => ({}));
    await new Promise((r) => setTimeout(r, 300));
    const reopened = new KeyLeaseEngine(() => clock.now, storage);
    reopened.configure("gemini", keys("g1"));
    expect(reopened.view("gemini", FLASH)[0].used).toBe(1);
  });

  it("explains a model that is not on the free tier", async () => {
    const { engine } = engineAt();
    engine.configure("gemini", keys("g1"));
    const error = await engine
      .execute({ provider: "gemini", model: "gemini-3.1-pro-preview", chatId: "c1" }, async () => {
        throw geminiQuota429({ daily: true, limit: 0, retry: "75015s" });
      })
      .catch((e) => e);
    expect(error.message).toMatch(/not available on the free tier/);
  });
});
