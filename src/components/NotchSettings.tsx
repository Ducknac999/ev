import { useEffect, useState } from "react";
import { caffeineRemovePermission, caffeineStatus, type Caffeine } from "../lib/ipc";
import { useClipboardError } from "../services/notchBridge";
import type { Settings } from "../types";
import { ComboField } from "./SettingsExtras";

type Update = (fn: (d: Settings) => void) => void;

/** Settings → Notch: E.V's own notch (or Vorssaint's), chat panels, full screen. */
export function NotchSettings({ draft, update }: { draft: Settings; update: Update }) {
  const notch = draft.notch;
  return (
    <div className="settings-card">
      <h4>The notch</h4>
      <p className="settings-intro">
        E.V's notch sits over your Mac's notch (or as a small pill at the top on Macs without one): what E.V heard and answered, approvals, music, the
        clipboard and more. Hover it to open it.
      </p>
      <label className="field">
        <span>Notch</span>
        <select value={notch.mode} onChange={(e) => update((d) => void (d.notch.mode = e.target.value as Settings["notch"]["mode"]))}>
          <option value="ev">E.V notch</option>
          <option value="vorssaint">Vorssaint (if you use it)</option>
          <option value="off">None</option>
        </select>
      </label>
      {notch.mode === "ev" && (
        <>
          <label className="check-row">
            <input type="checkbox" checked={notch.chatPanels} onChange={(e) => update((d) => void (d.notch.chatPanels = e.target.checked))} />
            <span>Chat panels — show E.V's window. Off: E.V lives in the notch (hover it, or use Talk mode); the Dock icon still opens the window.</span>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={notch.hideInFullscreen} onChange={(e) => update((d) => void (d.notch.hideInFullscreen = e.target.checked))} />
            <span>Hide the notch while an app is full screen, so it never covers the app's top bar. Push the pointer to the top edge to slide it out; approvals, answers and ⌘⇧C still show it</span>
          </label>
        </>
      )}
    </div>
  );
}

/** What the notch shows, one switch each (Settings → Notch, and the setup window's Notch step). */
export const NOTCH_FEATURES: { key: keyof Settings["notch"]["features"] | "clipboard"; label: string; detail: string }[] = [
  { key: "chat", label: "Chat", detail: "A mini chat with E.V from any app" },
  { key: "music", label: "Music", detail: "The song playing now, with controls and synced lyrics" },
  { key: "shelf", label: "Drop box", detail: "Park files, then drag them out wherever you need them" },
  { key: "clipboard", label: "Clipboard history", detail: "Everything you copy — ⌘⇧C, search, paste. Passwords are never kept" },
  { key: "dictation", label: "Dictation history", detail: "Your last 20 dictations, ready to copy" },
  { key: "caffeine", label: "☕ Caffeine", detail: "Keep your Mac awake, even with the lid closed" },
];

export function NotchFeatureSwitches({ settings, update }: { settings: Settings; update: Update }) {
  return (
    <div className="switch-list">
      {NOTCH_FEATURES.map((f) => {
        const on = f.key === "clipboard" ? settings.notch.clipboard.enabled : settings.notch.features[f.key];
        return (
          <label key={f.key} className="check-row switch-row">
            <span className="switch-text">
              <strong>{f.label}</strong>
              <small>{f.detail}</small>
            </span>
            <input
              type="checkbox"
              checked={on}
              onChange={(e) =>
                update((d) => {
                  if (f.key === "clipboard") d.notch.clipboard.enabled = e.target.checked;
                  else d.notch.features[f.key] = e.target.checked;
                })
              }
            />
          </label>
        );
      })}
    </div>
  );
}

/** Settings → Notch → What it shows (plus lyrics). */
export function NotchFeaturesSettings({ draft, update }: { draft: Settings; update: Update }) {
  if (draft.notch.mode !== "ev") return null;
  return (
    <div className="settings-card">
      <h4>What the notch shows</h4>
      <p className="settings-intro">Turn off what you don't use — it disappears from the notch.</p>
      <NotchFeatureSwitches settings={draft} update={update} />
      {draft.notch.features.music && (
        <label className="field">
          <span>Lyrics</span>
          <select value={draft.notch.lyrics} onChange={(e) => update((d) => void (d.notch.lyrics = e.target.value as Settings["notch"]["lyrics"]))}>
            <option value="keep">Save the last 100 songs (about 0.5 MB) so they show instantly</option>
            <option value="never">Never save them (fetched each time)</option>
          </select>
        </label>
      )}
    </div>
  );
}

/** Settings → Notch → ☕ Caffeine. */
export function CaffeineSettings({ draft, update }: { draft: Settings; update: Update }) {
  const notch = draft.notch;
  const [caffeine, setCaffeine] = useState<Caffeine | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    void caffeineStatus().then(setCaffeine).catch(() => {});
  }, []);
  if (notch.mode !== "ev" || !notch.features.caffeine) return null;
  return (
    <div className="settings-card">
      <h4>☕ Caffeine</h4>
      <p className="settings-intro">The ☕ in the notch keeps your Mac awake until you click it again — tasks and E.V keep running.</p>
      <label className="check-row">
        <input type="checkbox" checked={notch.caffeine.lid} onChange={(e) => update((d) => void (d.notch.caffeine.lid = e.target.checked))} />
        <span>
          Even with the lid closed (on battery too).{" "}
          {caffeine?.lidReady ? "Set up — switches on and off without a password." : "Asks for your Mac password once to set up."}
        </span>
      </label>
      <label className="field">
        <span>Turn ☕ off by itself</span>
        <select value={notch.caffeine.minutes} onChange={(e) => update((d) => void (d.notch.caffeine.minutes = Number(e.target.value)))}>
          <option value={0}>Never — only when I click it</option>
          <option value={30}>After 30 minutes</option>
          <option value={60}>After 1 hour</option>
          <option value={120}>After 2 hours</option>
          <option value={240}>After 4 hours</option>
          <option value={480}>After 8 hours</option>
        </select>
      </label>
      <label className="field">
        <span>Battery</span>
        <select value={notch.caffeine.batteryLimit} onChange={(e) => update((d) => void (d.notch.caffeine.batteryLimit = Number(e.target.value)))}>
          <option value={0}>Keep going, whatever the battery</option>
          <option value={10}>Turn off below 10%</option>
          <option value={20}>Turn off below 20%</option>
          <option value={30}>Turn off below 30%</option>
          <option value={50}>Turn off below 50%</option>
        </select>
      </label>
      <p className="settings-intro">If E.V quits or crashes while the lid-closed mode is on, sleep is turned back on — your Mac is never left unable to sleep.</p>
      {caffeine?.lidReady && (
        <button
          className="btn ghost"
          onClick={() =>
            void caffeineRemovePermission()
              .then((c) => (setCaffeine(c), setNote("Removed.")))
              .catch((err) => setNote(String(err)))
          }
        >
          Remove the lid-closed permission
        </button>
      )}
      {note && <p className="settings-intro">{note}</p>}
    </div>
  );
}

/** Settings → Instant actions: the on-device router (services/router.ts). */
export function InstantSettings({ draft, update }: { draft: Settings; update: (fn: (d: Settings) => void) => void }) {
  return (
    <div className="settings-card">
      <h4>Instant actions</h4>
      <p className="settings-intro">
        Simple things — volume, play/pause, dark mode, opening an app, finding a file, math, the time — are done right away, however you say them, with no AI and no
        tokens. Your Mac's own on-device model (Apple Intelligence, macOS 26) decides; anything it isn't sure about goes to your AI as usual. Requests your AI handled
        with one simple action are instant from then on.
      </p>
      <label className="check-row">
        <input type="checkbox" checked={draft.router.enabled} onChange={(e) => update((d) => void (d.router.enabled = e.target.checked))} />
        <span>Do simple requests instantly on this Mac</span>
      </label>
    </div>
  );
}

/** Settings → Dictation: typing by voice into any app, the clean-up, your dictionary. */
export function DictationSettings({ draft, update }: { draft: Settings; update: (fn: (d: Settings) => void) => void }) {
  const d = draft.voice.dictation;
  return (
    <div className="settings-card">
      <h4>Dictation · clean-up · dictionary</h4>
      <p className="settings-intro">
        Everything you say is turned into text on this Mac (Parakeet) and tidied before anything sees it — no “um”, no stutters, your spellings for names — so
        requests are shorter and cost fewer tokens. Nothing is sent anywhere for this.
      </p>
      <label className="check-row">
        <input type="checkbox" checked={d.enabled} onChange={(e) => update((s) => void (s.voice.dictation.enabled = e.target.checked))} />
        <span>Hold a key to dictate into any app — the words are typed where your cursor is</span>
      </label>
      {d.enabled && (
        <label className="field">
          <span>Dictation key (hold it, talk, let go)</span>
          <select value={d.shortcut} onChange={(e) => update((s) => void (s.voice.dictation.shortcut = e.target.value))}>
            <option value="rightoption">Right Option ⌥</option>
            <option value="rightcommand">Right Command ⌘</option>
            <option value="rightcontrol">Right Control ⌃</option>
            <option value="fn">fn / 🌐 (set System Settings → Keyboard → “Press 🌐 key to” → Do Nothing)</option>
            <option value="control+option+d">⌃⌥D</option>
          </select>
        </label>
      )}
      <label className="check-row">
        <input type="checkbox" checked={d.polished} onChange={(e) => update((s) => void (s.voice.dictation.polished = e.target.checked))} />
        <span>Polished: also fix self-corrections (“to Sam, no, to Maya” → “to Maya”) with Apple's on-device model (macOS 26) — adds about half a second</span>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={d.trailingSpace} onChange={(e) => update((s) => void (s.voice.dictation.trailingSpace = e.target.checked))} />
        <span>Add a space after each dictation, so back-to-back ones don't run together</span>
      </label>
      <p className="settings-intro">Your last 20 dictations: the notch's Dictation tab and the E.V icon in the menu bar (“Copy last dictation”).</p>
      <label className="check-row">
        <input type="checkbox" checked={d.doubleCommand} onChange={(e) => update((s) => void (s.voice.dictation.doubleCommand = e.target.checked))} />
        <span>Double-tap ⌘ to turn hands-free (Talk mode) on or off</span>
      </label>
      <p className="settings-intro">
        Hands-free, say: “type …” · “send it” · “new line” · “delete that” · “click Submit” · “take a screenshot” (or “… into Slack”) · “add Vorssaint to my
        dictionary”. While dictating: “comma”, “period”, “question mark”, “new line”, “new paragraph”.
      </p>
      <label className="field">
        <span>Your dictionary — names and words, one per line</span>
        <textarea
          rows={4}
          defaultValue={draft.voice.dictionary.join("\n")}
          placeholder={"Vorssaint\nDucknac\nE.V"}
          onBlur={(e) => update((s) => void (s.voice.dictionary = e.target.value.split(/\n|,/).map((w) => w.trim()).filter(Boolean)))}
        />
      </label>
    </div>
  );
}

/** Settings → Notch → Clipboard: the history of what you copy, in the notch. */
export function ClipboardSettings({ draft, update }: { draft: Settings; update: (fn: (d: Settings) => void) => void }) {
  const c = draft.notch.clipboard;
  const error = useClipboardError((s) => s.error);
  const others = [draft.panel.shortcut, draft.approvalKeys.approve, draft.approvalKeys.always, draft.approvalKeys.cancel, draft.voice.holdToTalk.enabled ? draft.voice.holdToTalk.shortcut : ""];
  const set = (fn: (clip: Settings["notch"]["clipboard"]) => void) => update((d) => void fn(d.notch.clipboard));
  if (draft.notch.mode !== "ev") return null;
  return (
    <div className="settings-card">
      <h4>📋 Clipboard</h4>
      <p className="settings-intro">
        Everything you copy — text, links, images, files — in the notch's Clipboard tab. Press the shortcut in any app, type to search, Enter pastes it where you
        were (⌥Enter only copies, ⌘1–⌘9 paste one of the first nine). Kept on this Mac only. Passwords from password managers are never kept.
      </p>
      <label className="check-row">
        <input type="checkbox" checked={c.enabled} onChange={(e) => set((clip) => void (clip.enabled = e.target.checked))} />
        <span>Keep a history of what I copy</span>
      </label>
      {c.enabled && (
        <>
          <ComboField label="Open the history" value={c.shortcut} onChange={(combo) => set((clip) => void (clip.shortcut = combo))} />
          {others.includes(c.shortcut) && <p className="settings-error">That combo is already used by another E.V shortcut.</p>}
          <p className="settings-intro">
            While E.V runs this shortcut is E.V's in every app (⌘⇧C is also Inspect Element in browsers). If another clipboard app uses the same keys, change one of them.
          </p>
          <label className="field">
            <span>Keep</span>
            <select value={c.limit} onChange={(e) => set((clip) => void (clip.limit = Number(e.target.value)))}>
              {[25, 50, 100, 200, 500].map((n) => (
                <option key={n} value={n}>
                  The last {n} (pinned ones stay too)
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Never keep copies from these apps — one per line (name or bundle ID)</span>
            <textarea
              rows={3}
              defaultValue={c.ignoreApps.join("\n")}
              onBlur={(e) =>
                set((clip) => void (clip.ignoreApps = e.target.value.split(/\n|,/).map((a) => a.trim()).filter(Boolean)))
              }
            />
          </label>
        </>
      )}
      {error && <p className="settings-error">{error}</p>}
    </div>
  );
}

/** Settings → Shortcuts: the clipboard history's shortcut (the same setting as Settings → Notch). */
export function ClipboardShortcutSettings({ draft, update }: { draft: Settings; update: Update }) {
  const c = draft.notch.clipboard;
  if (draft.notch.mode !== "ev" || !c.enabled) return null;
  return (
    <div className="settings-card">
      <h4>Clipboard history</h4>
      <p className="settings-intro">Opens everything you copied, in the notch, from any app.</p>
      <ComboField label="Open the history" value={c.shortcut} onChange={(combo) => update((d) => void (d.notch.clipboard.shortcut = combo))} />
    </div>
  );
}
