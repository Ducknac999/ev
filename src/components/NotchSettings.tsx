import { useEffect, useState } from "react";
import { caffeineRemovePermission, caffeineStatus, type Caffeine } from "../lib/ipc";
import type { Settings } from "../types";

/** Settings → General → Notch: E.V's own notch (or Vorssaint's), chat panels, lyrics, ☕. */
export function NotchSettings({ draft, update }: { draft: Settings; update: (fn: (d: Settings) => void) => void }) {
  const notch = draft.notch;
  const [caffeine, setCaffeine] = useState<Caffeine | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    void caffeineStatus().then(setCaffeine).catch(() => {});
  }, []);
  return (
    <div className="settings-card">
      <h4>Notch</h4>
      <p className="settings-intro">
        E.V's notch sits over your Mac's notch: what E.V heard and answered, approvals, a music card with lyrics, a drop box for files, ☕ and a small chat.
        Hover it to open it.
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
          <label className="field">
            <span>Lyrics</span>
            <select value={notch.lyrics} onChange={(e) => update((d) => void (d.notch.lyrics = e.target.value as Settings["notch"]["lyrics"]))}>
              <option value="keep">Save the last 100 songs (about 0.5 MB) so they show instantly</option>
              <option value="never">Never save them (fetched each time)</option>
            </select>
          </label>
          <h4 className="settings-sub">☕ Caffeine</h4>
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
        </>
      )}
    </div>
  );
}

/** Settings → General → Instant actions: the on-device router (services/router.ts). */
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

/** Settings → Voice → Dictation: typing by voice into any app, the clean-up, your dictionary. */
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
        <span>Polished: also fix self-corrections (“to Sam, no, to Maya” → “to Maya”) with Apple's on-device model (macOS 26)</span>
      </label>
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
