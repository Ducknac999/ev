import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { browserExtensionInstall, browserSwitchOn, gbStatus, type BrowserInfo } from "../lib/ipc";
import { installedBrowsers, noteBrowser, setPreferred } from "../services/browsers";
import { useSettings } from "../store/settings";
import type { KnownBrowser } from "../types";

/**
 * Settings → Browsers (and setup step 8): every browser on the Mac, what it's built on, how fast
 * E.V can work in its pages, and which one is the user's. E.V's lifetime memory of browsers lives
 * here, so it can be changed at any time.
 */

type Speed = { label: string; tone: "ok" | "warn" | "slow"; why: string };

function speedOf(b: BrowserInfo, known: KnownBrowser | undefined): Speed {
  if (b.route === "script") {
    if (known?.switch === "on") return { label: "Fastest", tone: "ok", why: "E.V works inside its pages — a whole job in a step or two." };
    return {
      label: known?.switch === "declined" ? "Fast control off" : "Fastest once turned on",
      tone: "warn",
      why: "Needs “Allow JavaScript from Apple Events” turned on once (E.V can do it for you). Until then E.V clicks through the window.",
    };
  }
  if (b.route === "extension") {
    if (b.connected) return { label: "Fastest (extension)", tone: "ok", why: "The E.V extension is connected." };
    return { label: "Fastest with the extension", tone: "warn", why: "Add the E.V extension once (about 4 clicks). Until then E.V clicks through the window." };
  }
  return { label: "Works, slower", tone: "slow", why: `Built on ${b.engineLabel.toLowerCase()} — E.V reads and clicks its window like a person, in batches.` };
}

export function BrowsersSettings({ compact = false }: { compact?: boolean }) {
  const memory = useSettings((s) => s.settings.browsers);
  const [list, setList] = useState<BrowserInfo[] | null>(null);
  const [engine, setEngine] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, { ok: boolean; text: string; steps?: string[] }>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void installedBrowsers(true).then(setList);
    void gbStatus().then((s) => setEngine(s.engine), () => setEngine(null));
  }, []);

  useEffect(() => {
    refresh();
    const off = listen("browser-extension-changed", refresh);
    const timer = window.setInterval(refresh, 8000);
    return () => {
      window.clearInterval(timer);
      void off.then((f) => f()).catch(() => {});
    };
  }, [refresh]);

  const toggleNotUsing = async (name: string, stopped: boolean) => {
    const next = structuredClone(useSettings.getState().settings);
    next.browsers.notUsing = stopped ? [...new Set([...next.browsers.notUsing, name])] : next.browsers.notUsing.filter((n) => n !== name);
    if (stopped && next.browsers.preferred === name) next.browsers.preferred = null;
    await useSettings.getState().save(next);
  };

  const turnOn = async (b: BrowserInfo) => {
    setBusy(b.name);
    try {
      const text = await browserSwitchOn(b.name);
      await noteBrowser(b.name, { engine: b.engine, route: "script", switch: "on" });
      setNote((n) => ({ ...n, [b.name]: { ok: true, text } }));
    } catch (err) {
      setNote((n) => ({ ...n, [b.name]: { ok: false, text: String(err) } }));
    } finally {
      setBusy(null);
    }
  };

  const addExtension = async (b: BrowserInfo) => {
    setBusy(b.name);
    try {
      const setup = await browserExtensionInstall(b.name);
      await noteBrowser(b.name, { engine: b.engine, route: "extension" });
      setNote((n) => ({ ...n, [b.name]: { ok: true, text: `Opened ${b.name}'s extensions page and the extension's folder:`, steps: setup.steps } }));
    } catch (err) {
      setNote((n) => ({ ...n, [b.name]: { ok: false, text: String(err) } }));
    } finally {
      setBusy(null);
    }
  };

  const usable = (list ?? []).filter((b) => !memory.notUsing.includes(b.name));
  const preferred = memory.preferred;

  return (
    <div className={compact ? "browsers-compact" : "settings-card"}>
      {!compact && <h4>Your browsers</h4>}
      <p className="settings-intro">
        When you ask E.V to do something in your browser, it works inside the page — reading every setting and changing many at once — instead of clicking one thing at a
        time. How fast depends on what the browser is built on; any browser works, even one made yesterday.
      </p>
      <label className="field">
        <span>The browser you use</span>
        <select value={preferred ?? ""} onChange={(e) => void setPreferred(e.target.value || null)}>
          <option value="">Let E.V work it out (asks once if it can't tell)</option>
          {usable.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
              {b.isDefault ? " (Mac's default)" : ""}
            </option>
          ))}
        </select>
      </label>
      {list === null ? (
        <div className="status-line">Looking for browsers…</div>
      ) : list.length === 0 ? (
        <div className="status-line bad">No browsers found.</div>
      ) : (
        <div className="browser-list">
          {list.map((b) => {
            const known = memory.known[b.name];
            const speed = speedOf(b, known);
            const stopped = memory.notUsing.includes(b.name);
            const n = note[b.name];
            const canTurnOn = b.route === "script" && known?.switch !== "on";
            const canAdd = b.route === "extension" && !b.connected;
            return (
              <div key={b.name} className={`browser-row${stopped ? " stopped" : ""}`}>
                <div className="browser-row-main">
                  <div className="browser-name">
                    {b.name}
                    {b.name === preferred && <span className="tag tag-free">yours</span>}
                    {b.isDefault && <span className="tag">default</span>}
                    {b.running && <span className="tag">open</span>}
                    {stopped && <span className="tag">not using</span>}
                  </div>
                  <div className="browser-engine">{b.engineLabel}</div>
                  <div className={`browser-speed ${speed.tone}`} title={speed.why}>
                    {speed.label}
                  </div>
                </div>
                {!compact && <p className="browser-why">{speed.why}</p>}
                <div className="connection-actions">
                  {canTurnOn && (
                    <button className="btn small primary" disabled={busy === b.name || !b.running} title={b.running ? undefined : `Open ${b.name} first`} onClick={() => void turnOn(b)}>
                      {busy === b.name ? "Turning on…" : "Turn on fast control"}
                    </button>
                  )}
                  {canAdd && (
                    <button className="btn small primary" disabled={busy === b.name} onClick={() => void addExtension(b)}>
                      Add the E.V extension
                    </button>
                  )}
                  {!compact && (
                    <button className="btn small" onClick={() => void toggleNotUsing(b.name, !stopped)}>
                      {stopped ? "I use this again" : "I don't use this"}
                    </button>
                  )}
                </div>
                {n && (
                  <div className={`status-line ${n.ok ? "ok" : "bad"}`}>
                    {n.text}
                    {n.steps && (
                      <ol className="browser-steps">
                        {n.steps.map((s) => (
                          <li key={s}>{s}</li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!compact && (
        <p className="connection-source">
          E.V's own hidden browser (for searching and its own accounts) runs on {engine ?? "a Chromium browser on this Mac"}, with a profile of its own — never yours.
        </p>
      )}
    </div>
  );
}
