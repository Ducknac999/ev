import { useEffect, useState } from "react";
import { claudeStatus, type ClaudeStatus } from "../lib/ipc";
import { KEYED_PROVIDERS, modelsFor, PROVIDER_ORDER, PROVIDERS } from "../providers/catalog";
import { useSettings } from "../store/settings";
import type { ModelRef, Settings } from "../types";
import { Icon } from "./Icon";
import { KeyPoolEditor } from "./KeyPoolEditor";
import { VoiceEngineSettings } from "./VoiceEngineSettings";
import { ConnectionsSettings } from "./ConnectionsSettings";
import { GideonBrowserSettings } from "./GideonBrowserSettings";
import { ClaudePlanUsage } from "./ClaudePlanUsage";
import { SpendingSettings } from "./SpendingSettings";
import { UpdateSettings } from "./UpdateSettings";
import { MoveInCard } from "./MoveInCard";
import {
  ActivitySettings,
  ApprovalKeysSettings,
  ApprovalsSettings,
  HoldToTalkSettings,
  QuickPanelSettings,
  LearnedTasksSettings,
  MemorySettings,
  PassphraseSettings,
  ScheduleSettings,
  SkillsSettings,
  TerminalSettings,
} from "./SettingsExtras";

type Tab = "providers" | "claude" | "approvals" | "connections" | "activity" | "learned" | "terminal" | "skills" | "memory" | "schedule" | "voice" | "general" | "updates";
const TABS: { id: Tab; label: string }[] = [
  { id: "updates", label: "Updates" },
  { id: "providers", label: "API keys" },
  { id: "claude", label: "Claude Code" },
  { id: "approvals", label: "Approvals" },
  { id: "connections", label: "Connections" },
  { id: "activity", label: "Activity" },
  { id: "learned", label: "Learned tasks" },
  { id: "memory", label: "Memory" },
  { id: "schedule", label: "Schedule" },
  { id: "voice", label: "Voice" },
  { id: "terminal", label: "Terminal" },
  { id: "skills", label: "Skills & rules" },
  { id: "general", label: "General" },
];

const splitList = (value: string) =>
  value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const saved = useSettings((s) => s.settings);
  const save = useSettings((s) => s.save);
  const [draft, setDraft] = useState<Settings>(() => structuredClone(saved));
  const [tab, setTab] = useState<Tab>("providers");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  useEffect(() => {
    claudeStatus().then(setClaude, () => setClaude({ available: false, path: null, version: null }));
  }, []);

  const commit = async (close: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await save(draft);
      if (close) onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "s" && e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        void commit(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const update = (fn: (d: Settings) => void) =>
    setDraft((d) => {
      const next = structuredClone(d);
      fn(next);
      return next;
    });

  const defaultKey = `${draft.defaultModel.provider}::${draft.defaultModel.model}`;

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings" role="dialog" aria-modal="true" aria-label="Settings">
        <nav className="settings-nav">
          <h3>Settings</h3>
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>

        <div className="settings-body">
          {tab === "providers" && (
            <>
              <p className="settings-intro">
                Each chat takes a key no other chat is using, so parallel chats never share a limit while a free key
                exists. When a key hits a limit, the chat moves to the next free key and the used-up key is skipped until
                it resets. Keys are stored in your user config directory with owner-only file permissions.
              </p>
              {KEYED_PROVIDERS.map((id) => (
                <div key={id} className="settings-card">
                  <KeyPoolEditor
                    provider={id}
                    draft={draft}
                    value={draft.providers[id]}
                    onChange={(next) => update((d) => void (d.providers[id] = next))}
                  />
                  <label className="field">
                    <span>Additional model IDs</span>
                    <input
                      className="mono"
                      placeholder="comma-separated, e.g. a newly released model id"
                      defaultValue={draft.providers[id].customModels.join(", ")}
                      onBlur={(e) => update((d) => void (d.providers[id].customModels = splitList(e.target.value)))}
                    />
                  </label>
                </div>
              ))}
            </>
          )}

          {tab === "claude" && (
            <div className="settings-card">
              <div className={`status-line ${claude?.available ? "ok" : "bad"}`}>
                <Icon name={claude?.available ? "check" : "alert"} size={14} />
                {claude === null
                  ? "Checking…"
                  : claude.available
                    ? `Found ${claude.version ?? "claude"} at ${claude.path}`
                    : "claude CLI not found on PATH"}
              </div>
              <p className="settings-intro">
                Claude runs as real Claude Code sessions (New → Claude Code) using your existing sign-in, rules and
                skills. Run as many at once as you like — they share the plan limits below. Approval prompts always
                appear; skip-permissions mode is locked off in your Claude Code settings.
              </p>
              <ClaudePlanUsage />
              <label className="field">
                <span>Folder for “Continue in Claude Code” on old Claude chats</span>
                <input
                  className="mono"
                  placeholder="~ (home directory)"
                  value={draft.claude.cwd}
                  onChange={(e) => update((d) => void (d.claude.cwd = e.target.value))}
                />
              </label>
              <label className="field">
                <span>Additional model aliases</span>
                <input
                  className="mono"
                  placeholder="comma-separated full model names"
                  defaultValue={draft.claude.customModels.join(", ")}
                  onBlur={(e) => update((d) => void (d.claude.customModels = splitList(e.target.value)))}
                />
              </label>
            </div>
          )}

          {tab === "voice" && (
            <>
            <VoiceEngineSettings draft={draft} update={update} />
            <div className="settings-card">
              <h4>Replies: when E.V talks</h4>
              <p className="settings-intro">One rule everywhere: answered the way you asked. Under each answer E.V notes why it did or didn't speak.</p>
              <label className="field">
                <span>When you type</span>
                <select value={draft.voice.replies.typed} onChange={(e) => update((d) => void (d.voice.replies.typed = e.target.value as "silent" | "speak"))}>
                  <option value="silent">Answer in text (say “…out loud” to hear one)</option>
                  <option value="speak">Answer out loud too</option>
                </select>
              </label>
              <label className="field">
                <span>When you speak a command (“next song”, “pause”, “open Spotify”)</span>
                <select value={draft.voice.replies.tasksOverMusic} onChange={(e) => update((d) => void (d.voice.replies.tasksOverMusic = e.target.value as "notch" | "speak"))}>
                  <option value="notch">Chime + quick line in the notch, never spoken</option>
                  <option value="speak">Say it out loud</option>
                </select>
              </label>
              <p className="settings-intro">When you speak a question, the answer is always said out loud (music pauses for it, if Now Playing says something's playing). Typed reminders get a chime and the notch; spoken ones are read back.</p>
              <label className="field">
                <span>Reminders, approvals and failed tasks</span>
                <select value={draft.voice.replies.important} onChange={(e) => update((d) => void (d.voice.replies.important = e.target.value as "speak" | "notch"))}>
                  <option value="speak">Always out loud and in the notch</option>
                  <option value="notch">Notch with a chime only</option>
                </select>
              </label>
              <p className="settings-intro">🔇 in the top bar mutes E.V completely: nothing is said, everything shows in the notch.</p>
            </div>
            <div className="settings-card">
              <h4>Hey E.V · Talk mode</h4>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={draft.voice.wakeWord}
                  onChange={(e) => update((d) => void (d.voice.wakeWord = e.target.checked))}
                />
                <span>Only respond when I start with “Hey E.V” — everything else is ignored and never sent</span>
              </label>
              <label className="field">
                <span>Follow-ups without “Hey E.V”</span>
                <select
                  value={draft.voice.followUps}
                  disabled={!draft.voice.wakeWord}
                  onChange={(e) => update((d) => void (d.voice.followUps = e.target.value as typeof d.voice.followUps))}
                >
                  <option value="always">After every answer (recommended)</option>
                  <option value="asked">Only when E.V asks me something</option>
                  <option value="never">Never — every request starts with “Hey E.V”</option>
                </select>
              </label>
              <label className="field">
                <span>Keep listening after each answer for {draft.voice.conversationSeconds} second{draft.voice.conversationSeconds === 1 ? "" : "s"}</span>
                <input
                  type="range"
                  min={2}
                  max={15}
                  step={1}
                  value={draft.voice.conversationSeconds}
                  disabled={!draft.voice.wakeWord || draft.voice.followUps === "never"}
                  onChange={(e) => update((d) => void (d.voice.conversationSeconds = Number(e.target.value)))}
                  aria-label="Seconds E.V keeps listening after an answer"
                />
              </label>
              <p className="settings-intro">
                Say your next request within that time and no “Hey E.V” is needed; every request starts the time again. Stay quiet longer and it goes back to waiting for “Hey E.V”. Shorter hears less around you; longer gives you more time. While E.V waits, the notch says “Waiting for your answer…”. Only a voice about as loud as yours counts, so a TV or people in another room are ignored. Say “I wasn't talking to you” and it gets stricter. Say “That's all” or “Thanks E.V” to end early.
              </p>
              <p className="settings-intro">
                Spoken or shown: questions are answered out loud (music pauses, then plays again); tasks are confirmed in the notch while music keeps playing. Say “…out loud” or “…quietly” to choose, “say that” to hear the last notch answer, or “shh” to move a spoken answer to the notch. When E.V and the panel aren't in front, answers also show in the notch (2–7 seconds).
              </p>

              <label className="check-row">
                <input
                  type="checkbox"
                  checked={draft.voice.echoCancellation}
                  onChange={(e) => update((d) => void (d.voice.echoCancellation = e.target.checked))}
                />
                <span>Echo cancellation — only if you use speakers (macOS turns other audio down while it's on). Takes effect next time Talk mode starts.</span>
              </label>

            </div>
            <HoldToTalkSettings draft={draft} update={update} />
            <QuickPanelSettings draft={draft} update={update} />
            <PassphraseSettings />
            </>
          )}

          {tab === "terminal" && <TerminalSettings draft={draft} update={update} />}
          {tab === "skills" && <SkillsSettings />}
          {tab === "approvals" && (
            <>
              <ApprovalKeysSettings draft={draft} update={update} />
              <ApprovalsSettings />
            </>
          )}
          {tab === "connections" && (
            <>
              <GideonBrowserSettings />
              <ConnectionsSettings />
            </>
          )}
          {tab === "activity" && <ActivitySettings />}
          {tab === "learned" && <LearnedTasksSettings />}
          {tab === "memory" && <MemorySettings />}
          {tab === "schedule" && <ScheduleSettings draft={draft} update={update} />}

          {tab === "general" && (
            <div className="settings-card">
              <label className="field">
                <span>Top bar style</span>
                <select value={draft.topBarStyle} onChange={(e) => update((d) => void (d.topBarStyle = e.target.value as typeof d.topBarStyle))}>
                  <option value="full">Full</option>
                  <option value="compact">Compact — icons only</option>
                </select>
              </label>
              <label className="field">
                <span>Show the top bar</span>
                <select value={draft.topBarShow} onChange={(e) => update((d) => void (d.topBarShow = e.target.value as typeof d.topBarShow))}>
                  <option value="always">Always</option>
                  <option value="hover">When the cursor reaches the top (or ⌥⌘B)</option>
                </select>
              </label>
              <label className="field">
                <span>Default model for new chats</span>
                <select
                  value={defaultKey}
                  onChange={(e) => {
                    const [provider, model] = e.target.value.split("::") as [ModelRef["provider"], string];
                    update((d) => void (d.defaultModel = { provider, model }));
                  }}
                >
                  {PROVIDER_ORDER.map((p) => (
                    <optgroup key={p} label={PROVIDERS[p].label}>
                      {modelsFor(p, draft).map((m) => (
                        <option key={m.id} value={`${p}::${m.id}`}>
                          {m.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>When a screen question needs a picture but the chat's model can't see pictures</span>
                <select value={draft.screenPicture} onChange={(e) => update((d) => void (d.screenPicture = e.target.value as Settings["screenPicture"]))}>
                  <option value="ask">Ask me first (recommended)</option>
                  <option value="vision">Use Flash · Vision just for that look (extra tokens)</option>
                  <option value="text">Never — read the screen as text only (fewest tokens)</option>
                </select>
              </label>
              <label className="field">
                <span>System prompt (all providers)</span>
                <textarea
                  rows={5}
                  value={draft.systemPrompt}
                  placeholder="Optional instructions prepended to every conversation"
                  onChange={(e) => update((d) => void (d.systemPrompt = e.target.value))}
                />
              </label>
              <h4>Keyboard shortcuts</h4>
              <dl className="shortcuts">
                {[
                  ["⌘N", "New session (Claude Code, Gemini, terminal, command)"],
                  ["⌘T", "New terminal in the last folder"],
                  ["⌘B", "Sessions sidebar"],
                  ["⌘F", "Search terminal output"],
                  ["⌘1 – ⌘9", "Focus chat"],
                  ["⌘⇧M", "Minimize focused chat to task bar"],
                  ["⌘⇧W", "Close focused chat"],
                  ["⌘.", "Stop generating / interrupt terminal"],
                  ["⌘\\", "Cycle layout"],
                  ["⌘⇧T", "Toggle talk mode"],
                  ["⌘⇧V", "Toggle voice replies"],
                  ["Esc", "Stop speaking / close dialogs"],
                  ["⌘,", "Settings"],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt>
                      <kbd>{k}</kbd>
                    </dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          {tab === "general" && <SpendingSettings draft={draft} update={update} />}
          {tab === "updates" && <UpdateSettings />}
          {tab === "general" && <MoveInCard />}
          {tab === "general" && (
            <div className="settings-card">
              <h4>Setup</h4>
              <p className="settings-intro">Go through the start window again: coding agents, keys, local models, passphrase, permissions and voice.</p>
              <button className="btn" onClick={() => void useSettings.getState().save({ ...useSettings.getState().settings, onboarded: false }).then(onClose)}>
                Run setup again
              </button>
            </div>
          )}
        </div>

        <footer className="settings-foot">
          {error && <span className="error-text">{error}</span>}
          <div className="pane-spacer" />
          <button className="btn ghost" onClick={onClose}>
            {dirty ? "Discard" : "Close"}
          </button>
          <button className="btn primary" onClick={() => commit(true)} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save"} <kbd>⌘S</kbd>
          </button>
        </footer>
      </div>
    </div>
  );
}
