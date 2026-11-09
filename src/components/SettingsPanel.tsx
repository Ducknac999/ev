import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import {
  CaffeineSettings,
  ClipboardSettings,
  ClipboardShortcutSettings,
  DictationSettings,
  InstantSettings,
  NotchFeaturesSettings,
  NotchSettings,
} from "./NotchSettings";
import { GROUPS, pageInfo, searchSettings, type Page, type SettingEntry } from "./settingsSearch";
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

/** A card search can jump to (and briefly light up). */
function Anchor({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div className="settings-anchor" data-anchor={id}>
      {children}
    </div>
  );
}

const splitList = (value: string) =>
  value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const saved = useSettings((s) => s.settings);
  const save = useSettings((s) => s.save);
  const [draft, setDraft] = useState<Settings>(() => structuredClone(saved));
  const [tab, setTab] = useState<Page>("models");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState(0);
  const [found, setFound] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const hits = useMemo(() => searchSettings(query), [query]);
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
      if (e.key === "f" && e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "Escape") {
        e.stopPropagation();
        if (query) setQuery("");
        else onClose();
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

  /** Opens a search result: its page, scrolled to it, lit up for a moment. */
  const open = (entry: SettingEntry) => {
    setTab(entry.page);
    setQuery("");
    setFound(entry.anchor);
  };
  useEffect(() => {
    if (!found) return;
    const id = window.requestAnimationFrame(() => {
      const el = bodyRef.current?.querySelector<HTMLElement>(`[data-anchor="${found}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
      el?.classList.add("found");
    });
    const off = window.setTimeout(() => {
      bodyRef.current?.querySelector(".settings-anchor.found")?.classList.remove("found");
      setFound(null);
    }, 1800);
    return () => (window.cancelAnimationFrame(id), window.clearTimeout(off));
  }, [found, tab]);
  useEffect(() => setPicked(0), [query]);

  const page = pageInfo(tab);
  const defaultKey = `${draft.defaultModel.provider}::${draft.defaultModel.model}`;

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings" role="dialog" aria-modal="true" aria-label="Settings">
        <nav className="settings-nav">
          <h3>Settings</h3>
          <div className="settings-search">
            <Icon name="search" size={13} />
            <input
              ref={searchRef}
              value={query}
              placeholder="Search  ⌘F"
              aria-label="Search settings"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") (e.preventDefault(), setPicked((i) => Math.min(hits.length - 1, i + 1)));
                else if (e.key === "ArrowUp") (e.preventDefault(), setPicked((i) => Math.max(0, i - 1)));
                else if (e.key === "Enter" && hits[picked]) (e.preventDefault(), open(hits[picked].entry));
              }}
            />
            {query && (
              <button className="settings-search-clear" title="Clear" onClick={() => setQuery("")}>
                <Icon name="close" size={11} />
              </button>
            )}
          </div>
          {query.trim() ? (
            <div className="settings-results" role="listbox" aria-label="Matching settings">
              {hits.length === 0 ? (
                <p className="settings-noresult">No setting matches “{query.trim()}”.</p>
              ) : (
                hits.map((h, i) => (
                  <button
                    key={`${h.entry.page}-${h.entry.title}`}
                    role="option"
                    aria-selected={i === picked}
                    className={i === picked ? "active" : ""}
                    onMouseEnter={() => setPicked(i)}
                    onClick={() => open(h.entry)}
                  >
                    <span className="result-title">{h.entry.title}</span>
                    <span className="result-where">
                      <Icon name={pageInfo(h.entry.page).icon} size={11} /> {pageInfo(h.entry.page).label}
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : (
            <div className="settings-groups">
              {GROUPS.map((g) => (
                <div key={g.label} className="settings-group">
                  <div className="settings-group-label">{g.label}</div>
                  {g.pages.map((p) => (
                    <button key={p.id} className={tab === p.id ? "active" : ""} onClick={() => setTab(p.id)}>
                      <Icon name={p.icon} size={14} />
                      <span>{p.label}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </nav>

        <div className="settings-body" ref={bodyRef}>
          <header className="settings-page-head">
            <span className="settings-page-icon">
              <Icon name={page.icon} size={18} />
            </span>
            <div>
              <h2>{page.label}</h2>
              <p>{page.blurb}</p>
            </div>
          </header>
          {tab === "models" && (
            <>
              <Anchor id="default-model">
                <div className="settings-card">
                  <h4>Default model</h4>
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
                </div>
              </Anchor>
              <Anchor id="spending">
                <SpendingSettings draft={draft} update={update} />
              </Anchor>
              <Anchor id="keys">
                <div className="settings-stack">
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
                </div>
              </Anchor>
            </>
          )}

          {tab === "claude" && (
            <Anchor id="claude">
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
            </Anchor>
          )}

          {tab === "skills" && (
            <>
              <Anchor id="system-prompt">
                <div className="settings-card">
                  <h4>Instructions for every chat</h4>
              <label className="field">
                <span>System prompt (all providers)</span>
                <textarea
                  rows={5}
                  value={draft.systemPrompt}
                  placeholder="Optional instructions prepended to every conversation"
                  onChange={(e) => update((d) => void (d.systemPrompt = e.target.value))}
                />
              </label>
                </div>
              </Anchor>
              <Anchor id="skills">
                <SkillsSettings />
              </Anchor>
            </>
          )}
          {tab === "memory" && (
            <Anchor id="memory">
              <MemorySettings />
            </Anchor>
          )}
          {tab === "learned" && (
            <Anchor id="learned">
              <LearnedTasksSettings />
            </Anchor>
          )}

          {tab === "voice" && (
            <>
              <Anchor id="voice-engine">
                <VoiceEngineSettings draft={draft} update={update} />
              </Anchor>
              <Anchor id="replies">
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
              </Anchor>
              <Anchor id="talk-mode">
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
              </Anchor>
            </>
          )}
          {tab === "dictation" && (
            <Anchor id="dictation">
              <DictationSettings draft={draft} update={update} />
            </Anchor>
          )}
          {tab === "shortcuts" && (
            <>
              <Anchor id="hold-to-talk">
                <HoldToTalkSettings draft={draft} update={update} />
              </Anchor>
              <Anchor id="quick-panel">
                <QuickPanelSettings draft={draft} update={update} />
              </Anchor>
              <Anchor id="clipboard-key">
                <ClipboardShortcutSettings draft={draft} update={update} />
              </Anchor>
              <Anchor id="approval-keys">
                <ApprovalKeysSettings draft={draft} update={update} />
              </Anchor>
              <Anchor id="app-shortcuts">
                <div className="settings-card">
                  <h4>Inside E.V</h4>
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
              </Anchor>
            </>
          )}

          {tab === "notch" && (
            <>
              <Anchor id="notch">
                <NotchSettings draft={draft} update={update} />
              </Anchor>
              <Anchor id="notch-features">
                <NotchFeaturesSettings draft={draft} update={update} />
              </Anchor>
              <Anchor id="clipboard">
                <ClipboardSettings draft={draft} update={update} />
              </Anchor>
              <Anchor id="caffeine">
                <CaffeineSettings draft={draft} update={update} />
              </Anchor>
            </>
          )}

          {tab === "approvals" && (
            <>
              <Anchor id="approvals">
                <ApprovalsSettings />
              </Anchor>
              <Anchor id="passphrase">
                <PassphraseSettings />
              </Anchor>
            </>
          )}
          {tab === "connections" && (
            <>
              <Anchor id="connections">
                <ConnectionsSettings />
              </Anchor>
              <Anchor id="browser">
                <GideonBrowserSettings />
              </Anchor>
            </>
          )}
          {tab === "instant" && (
            <Anchor id="instant">
              <InstantSettings draft={draft} update={update} />
            </Anchor>
          )}
          {tab === "schedule" && (
            <Anchor id="schedule">
              <ScheduleSettings draft={draft} update={update} />
            </Anchor>
          )}
          {tab === "activity" && (
            <Anchor id="activity">
              <ActivitySettings />
            </Anchor>
          )}

          {tab === "general" && (
            <>
              <Anchor id="look">
                <div className="settings-card">
                  <h4>Look</h4>
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
                </div>
              </Anchor>
              <Anchor id="terminal">
                <TerminalSettings draft={draft} update={update} />
              </Anchor>
              <Anchor id="setup">
            <div className="settings-card">
              <h4>Setup</h4>
              <p className="settings-intro">Go through the start window again: coding agents, keys, local models, passphrase, permissions, voice and the notch.</p>
              <button className="btn" onClick={() => void useSettings.getState().save({ ...useSettings.getState().settings, onboarded: false }).then(onClose)}>
                Run setup again
              </button>
            </div>
          </Anchor>
          <Anchor id="move-in"><MoveInCard /></Anchor>
            </>
          )}
          {tab === "updates" && (
            <Anchor id="updates">
              <UpdateSettings />
            </Anchor>
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
