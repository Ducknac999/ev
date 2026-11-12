import { browserInfo, browsersList, browsersSetPreferred, macDefaultBrowser, macTabs, type BrowserInfo } from "../lib/ipc";
import { useSettings } from "../store/settings";
import type { KnownBrowser } from "../types";

/**
 * Which browser is the user's, kept in E.V's lifetime memory (Settings → Browsers) so every chat
 * knows it. E.V picks it in this order: the browser the user names in a message; the one it
 * remembers; the running browser that has the tab the user mentioned; the Mac's default browser.
 * Only when none of those settle it does E.V ask, once.
 */

let cache: { at: number; list: BrowserInfo[] } | null = null;

export async function installedBrowsers(fresh = false): Promise<BrowserInfo[]> {
  if (!fresh && cache && Date.now() - cache.at < 30_000) return cache.list;
  const list = await browsersList().catch(() => cache?.list ?? []);
  cache = { at: Date.now(), list };
  return list;
}

/** Names people use for a browser: "Brave Browser" → brave, "Google Chrome" → chrome. */
export function aliases(name: string): string[] {
  const full = name.toLowerCase().trim();
  const words = full.split(/\s+/);
  const out = new Set([full]);
  if (words.length > 1 && words.at(-1) === "browser") out.add(words.slice(0, -1).join(" "));
  if (words.length > 1 && ["google", "microsoft", "mozilla", "firefox"].includes(words[0])) out.add(words.slice(1).join(" "));
  if (full === "firefox developer edition" || full === "firefox nightly") out.add("firefox");
  return [...out].filter((a) => a.length > 2);
}

function mentions(text: string, alias: string): RegExpExecArray | null {
  return new RegExp(`(^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").exec(text);
}

const STOPPED = /\b(?:stopp?ed using|stop using|quit using|don'?t use|do not use|no longer use|not using|switched (?:away )?from|moved (?:away )?from|gave up(?: on)?|uninstalled|deleted)\s+(?:the\s+|my\s+)?$/i;
const NOT_ANYMORE = /^\s*(?:browser\s+)?(?:any ?more|no more)\b/i;

/** What a message says about the user's browsers: the one they use, and ones they stopped using. */
export function browsersNamed(text: string, installed: string[]): { use: string | null; stopped: string[] } {
  const stopped: string[] = [];
  const used: { name: string; at: number }[] = [];
  for (const name of installed) {
    for (const alias of aliases(name)) {
      const hit = mentions(text, alias);
      if (!hit) continue;
      const at = hit.index + hit[1].length;
      const before = text.slice(Math.max(0, at - 40), at);
      const after = text.slice(at + alias.length, at + alias.length + 20);
      if (STOPPED.test(before) || NOT_ANYMORE.test(after)) stopped.push(name);
      else used.push({ name, at });
      break;
    }
  }
  const use = used.filter((u) => !stopped.includes(u.name)).sort((a, b) => a.at - b.at)[0]?.name ?? null;
  return { use, stopped: [...new Set(stopped)] };
}

async function saveMemory(change: (b: ReturnType<typeof memory>) => void): Promise<void> {
  const next = structuredClone(useSettings.getState().settings);
  change(next.browsers);
  await useSettings.getState().save(next);
  void browsersSetPreferred(next.browsers.preferred).catch(() => {});
}

export function memory() {
  return useSettings.getState().settings.browsers;
}

/** A message named a browser: remember it for every chat (and the ones they stopped using). */
export async function learnFromMessage(text: string): Promise<{ use: string | null; stopped: string[] }> {
  const list = await installedBrowsers();
  const said = browsersNamed(text, list.map((b) => b.name));
  if (!said.use && !said.stopped.length) return said;
  const now = memory();
  const changes = (said.use && now.preferred !== said.use) || said.stopped.some((s) => !now.notUsing.includes(s)) || (said.use && now.notUsing.includes(said.use));
  if (changes) {
    await saveMemory((b) => {
      if (said.use) b.preferred = said.use;
      b.notUsing = [...new Set([...b.notUsing.filter((n) => n !== said.use), ...said.stopped])];
      if (b.preferred && b.notUsing.includes(b.preferred)) b.preferred = null;
    });
  }
  return said;
}

export async function setPreferred(name: string | null): Promise<void> {
  await saveMemory((b) => {
    b.preferred = name;
    if (name) b.notUsing = b.notUsing.filter((n) => n !== name);
  });
}

/** What E.V found out about a browser while working in it (engine, route, switch). */
export async function noteBrowser(name: string, patch: Partial<KnownBrowser>): Promise<void> {
  const before = memory().known[name];
  const next: KnownBrowser = { ...(before ?? { engine: "unknown", route: "accessibility" }), ...patch, checkedAt: Date.now() };
  if (before && JSON.stringify({ ...before, checkedAt: 0 }) === JSON.stringify({ ...next, checkedAt: 0 })) return;
  await saveMemory((b) => {
    b.known[name] = next;
  });
}

export interface BrowserPick {
  name: string;
  /** How E.V knew: named · memory · tab · default · only · asked */
  how: "named" | "memory" | "tab" | "default" | "only" | "asked";
}

/** Matches what the AI wrote ("Chrome", "brave") to an installed browser. */
export function matchInstalled(want: string, list: BrowserInfo[]): BrowserInfo | null {
  const w = want.trim().toLowerCase().replace(/\.app$/, "");
  if (!w) return null;
  return list.find((b) => b.name.toLowerCase() === w) ?? list.find((b) => aliases(b.name).includes(w)) ?? list.find((b) => b.name.toLowerCase().includes(w)) ?? null;
}

/**
 * The browser to work in. `named` is what the AI passed; `tab` the page the user mentioned
 * ("cstimer"). `ask` shows the user a choice and returns their answer (null if skipped).
 */
export async function pickBrowser(named: string, tab: string, ask: ((question: string, options: string[]) => Promise<string | null>) | null): Promise<BrowserPick | null> {
  const list = await installedBrowsers();
  const mem = memory();
  if (named) {
    const hit = matchInstalled(named, list);
    if (hit) return { name: hit.name, how: "named" };
    // Not in macOS's list of web apps (a browser built by hand, run from a folder): trust the name.
    const info = await browserInfo(named).catch(() => null);
    if (info) return { name: info.name, how: "named" };
  }
  if (mem.preferred && matchInstalled(mem.preferred, list)) return { name: mem.preferred, how: "memory" };
  const candidates = list.filter((b) => !mem.notUsing.includes(b.name));
  const want = tab.trim().toLowerCase();
  if (want) {
    const running = candidates.filter((b) => b.running && b.engine !== "unknown");
    const withTab: string[] = [];
    for (const b of running) {
      const tabs = await macTabs(b.name, "list").catch(() => []);
      if (tabs.some((t) => t.url.toLowerCase().includes(want) || t.title.toLowerCase().includes(want))) withTab.push(b.name);
    }
    if (withTab.length === 1) {
      await setPreferred(withTab[0]);
      return { name: withTab[0], how: "tab" };
    }
  }
  if (candidates.length === 1) return { name: candidates[0].name, how: "only" };
  const fallback = await macDefaultBrowser().catch(() => "");
  const def = candidates.find((b) => b.name === fallback);
  // No tab to go by: the Mac's default browser. A tab that isn't in exactly one browser: ask.
  if (def && (!want || !ask)) return { name: def.name, how: "default" };
  if (ask && candidates.length > 1) {
    const ordered = [...candidates].sort((a, b) => Number(b.running) - Number(a.running) || Number(b.isDefault) - Number(a.isDefault));
    const answer = await ask("Which browser should I use? I'll remember it for every chat (you can change it in Settings → Browsers).", ordered.slice(0, 4).map((b) => b.name));
    const hit = answer ? matchInstalled(answer, list) : null;
    if (hit) {
      await setPreferred(hit.name);
      return { name: hit.name, how: "asked" };
    }
  }
  return def ? { name: def.name, how: "default" } : candidates[0] ? { name: candidates[0].name, how: "only" } : null;
}

/** One line for the AI's instructions: which browser is the user's and how E.V works in it. */
export async function browserPromptLine(): Promise<{ name: string; known: boolean; others: string[] }> {
  const mem = memory();
  const list = await installedBrowsers();
  const fallback = mem.preferred ?? (await macDefaultBrowser().catch(() => "Safari"));
  return { name: fallback, known: Boolean(mem.preferred), others: list.map((b) => b.name).filter((n) => n !== fallback && !mem.notUsing.includes(n)) };
}
