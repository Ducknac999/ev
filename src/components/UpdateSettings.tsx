import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useState } from "react";
import { updateReleases, type ReleaseInfo } from "../lib/ipc";
import { useSettings } from "../store/settings";

/**
 * Settings → General → Updates. Reads the public repo's releases: up to date, or how many versions
 * behind and what each one changed (tagged Security / Features / UI / Fixes). Update downloads the
 * newest version — signed with the project's own key, so nothing else can pose as an update —
 * installs it and restarts. Settings, keys and chats stay where they are.
 */

/** "1.10.0" > "1.9.2" */
function newer(a: string, b: string): boolean {
  const x = a.split(".").map((n) => parseInt(n, 10) || 0);
  const y = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

const KINDS = ["Security", "Features", "UI", "Fixes"] as const;

/** The kinds of change a release lists (its "## Security"-style headings, or [Security]-style tags). */
function kindsOf(notes: string): string[] {
  return KINDS.filter((k) => new RegExp(`(^|\\n)\\s*(#+\\s*${k}\\b|\\[${k}\\])`, "i").test(notes));
}

/** The release notes as short lines (headings and bullets kept, links and markup dropped). */
function summary(notes: string): string[] {
  return notes
    .split("\n")
    .map((l) => l.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`]/g, "").trim())
    .filter((l) => l && !/^#+\s*(security|features|ui|fixes)\b/i.test(l))
    .map((l) => l.replace(/^[-•]\s*/, "• ").replace(/^#+\s*/, ""))
    .slice(0, 8);
}

export function UpdateSettings() {
  const [version, setVersion] = useState("");
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [releases, setReleases] = useState<ReleaseInfo[] | null>(null);
  const [state, setState] = useState<{ checking: boolean; error: string; progress: number | null }>({ checking: false, error: "", progress: null });
  const auto = useSettings((s) => s.settings.onboarded);

  useEffect(() => {
    void getVersion().then(setVersion).catch(() => {});
    // Opening the tab checks right away.
    void checkNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkNow = async () => {
    setState({ checking: true, error: "", progress: null });
    try {
      setReleases(await updateReleases());
      setCheckedAt(new Date());
      setState({ checking: false, error: "", progress: null });
    } catch (err) {
      setState({ checking: false, error: String(err), progress: null });
    }
  };

  const install = async () => {
    setState({ checking: false, error: "", progress: 0 });
    try {
      const update: Update | null = await check();
      if (!update) {
        setState({ checking: false, error: "No update was offered — you may already have the newest version.", progress: null });
        return;
      }
      let total = 0;
      let done = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event === "Progress") {
          done += event.data.chunkLength;
          setState((s) => ({ ...s, progress: total ? done / total : 0.5 }));
        }
        if (event.event === "Finished") setState((s) => ({ ...s, progress: 1 }));
      });
      await relaunch();
    } catch (err) {
      setState({ checking: false, error: `Update failed: ${String(err)}`, progress: null });
    }
  };

  const ahead = (releases ?? []).filter((r) => version && newer(r.version, version));
  return (
    <div className="settings-card">
      <h4>Updates</h4>
      <p className="settings-intro">
        You're on <strong>E.V {version || "…"}</strong>.{" "}
        {releases === null || !version
          ? "Checking for a newer version…"
          : ahead.length === 0
            ? `You're up to date — ${version} is the newest version${checkedAt ? ` (checked at ${checkedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })})` : ""}.`
            : `You're ${ahead.length} version${ahead.length === 1 ? "" : "s"} behind. Here's what you'll get:`}
      </p>
      {ahead.length > 0 && (
        <div className="update-list">
          {ahead.map((r) => (
            <div key={r.version} className="update-item">
              <div className="update-head">
                <strong>{r.version}</strong>
                {r.date && <span className="muted">{r.date}</span>}
                {kindsOf(r.notes).map((k) => (
                  <span key={k} className={`update-tag tag-${k.toLowerCase()}`}>
                    {k}
                  </span>
                ))}
              </div>
              {summary(r.notes).map((line, i) => (
                <div key={i} className="update-line">
                  {line}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="update-actions">
        <button className="btn" disabled={state.checking || state.progress !== null} onClick={() => void checkNow()}>
          {state.checking ? "Checking…" : "Check for updates"}
        </button>
        {ahead.length > 0 && (
          <button className="btn neon" disabled={state.progress !== null} onClick={() => void install()}>
            {state.progress === null ? `Update to ${ahead[0].version}` : state.progress >= 1 ? "Restarting…" : `Downloading… ${Math.round(state.progress * 100)}%`}
          </button>
        )}
      </div>
      {state.error && <p className="ob-error">{state.error}</p>}
      {auto && <p className="settings-intro">Your settings, keys and chats stay when E.V updates.</p>}
    </div>
  );
}
