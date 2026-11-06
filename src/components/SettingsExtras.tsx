import { useEffect, useState } from "react";
import { agentContext, macPermissions, macRequestPermission, passphraseCheck, passphraseClear, passphraseMatches, passphraseSet, type AgentContext } from "../lib/ipc";
import { CATEGORIES, type Category, type Level } from "../providers/agent/policy";
import { dictation } from "../services/voiceControl";
import { audioEngine } from "../audio/engine";
import { refreshPassphraseStatus } from "../services/voiceApproval";
import { uid } from "../lib/ids";
import type { MemoryKind, Repeat, Settings } from "../types";
import { looksSecret } from "../providers/agent/memoryTools";
import { userTimeZone } from "../providers/agent/liveTools";
import { describeEvent, upcoming } from "../services/schedule";
import { useHoldToTalk } from "../services/holdToTalk";
import { useApprovalKeys } from "../services/approvalPopup";
import { useQuickPanel } from "../services/quickPanel";
import { COMBOS, shortcutLabel, SINGLE_KEYS } from "../lib/shortcuts";
import { useChats } from "../store/chats";
import { useVault } from "../store/vault";
import { Icon } from "./Icon";

type Update = (fn: (d: Settings) => void) => void;

/** Terminal font, Claude resume behaviour and saved commands (presets). */
export function TerminalSettings({ draft, update }: { draft: Settings; update: Update }) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const add = () => {
    if (!command.trim()) return;
    update((d) => void d.terminal.presets.push({ id: uid("preset-"), name: name.trim() || command.trim(), command: command.trim() }));
    setName("");
    setCommand("");
  };
  return (
    <div className="settings-card">
      <h4>Terminal</h4>
      <label className="field">
        <span>Font size · {draft.terminal.fontSize}px</span>
        <input
          type="range"
          min={9}
          max={24}
          value={draft.terminal.fontSize}
          onChange={(e) => update((d) => void (d.terminal.fontSize = Number(e.target.value)))}
        />
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={draft.terminal.resumeClaude}
          onChange={(e) => update((d) => void (d.terminal.resumeClaude = e.target.checked))}
        />
        <span>When E.V starts, Claude Code sessions resume where they left off</span>
      </label>

      <h4>Presets</h4>
      <p className="settings-intro">Saved commands. Run them from the sidebar or the New session → Command dialog.</p>
      {draft.terminal.presets.length === 0 && <div className="key-empty muted">No presets yet.</div>}
      <ol className="key-list">
        {draft.terminal.presets.map((p, i) => (
          <li key={p.id} className="preset-row">
            <input
              className="key-name"
              value={p.name}
              onChange={(e) => update((d) => void (d.terminal.presets[i].name = e.target.value))}
              aria-label="Preset name"
            />
            <input
              className="key-input mono"
              value={p.command}
              onChange={(e) => update((d) => void (d.terminal.presets[i].command = e.target.value))}
              aria-label="Preset command"
            />
            <button className="icon-btn ghost" title={`Remove ${p.name}`} onClick={() => update((d) => void d.terminal.presets.splice(i, 1))}>
              <Icon name="trash" size={14} />
            </button>
          </li>
        ))}
      </ol>
      <div className="key-add">
        <input className="key-name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          className="mono"
          placeholder="Command, e.g. npm run dev"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="btn" onClick={add} disabled={!command.trim()}>
          <Icon name="plus" size={13} /> Add
        </button>
      </div>
    </div>
  );
}

/** The rules and skills every AI in E.V receives, read live from ~/.claude. */
export function SkillsSettings() {
  const [context, setContext] = useState<AgentContext | null>(null);
  useEffect(() => {
    agentContext("~").then(setContext, () => setContext(null));
  }, []);
  if (!context) return <div className="settings-card muted">Loading skills…</div>;
  const usable = context.skills.filter((s) => !s.claudeOnly);
  const claudeOnly = context.skills.filter((s) => s.claudeOnly);
  return (
    <>
      <div className="settings-card">
        <h4>Rules for every AI</h4>
        <p className="settings-intro">
          Claude Code and every AI in E.V (Gemini, Groq, and any you add later) follow the same file:
          <code> ~/.claude/CLAUDE.md</code>. Edit it once (or tell any AI “save rule …”) and every session picks it up.
          E.V Chats also load the project’s <code>CLAUDE.md</code> and, on a fresh or cleared context,{" "}
          <code>SUMMARY.md</code>.
        </p>
        <div className={`status-line ${context.globalRules ? "ok" : "bad"}`}>
          <Icon name={context.globalRules ? "check" : "alert"} size={14} />
          {context.globalRules ? `Global rules loaded · ${context.globalRules.split("\n").length} lines` : "No ~/.claude/CLAUDE.md found"}
        </div>
        <div className="status-line ok">
          <Icon name="shield" size={14} /> Every action needs your approval — E.V has no skip-permissions mode
        </div>
      </div>
      <div className="settings-card">
        <h4>Skills · {usable.length} for every AI</h4>
        <ul className="skill-list">
          {usable.map((s) => (
            <li key={s.name}>
              <span className="skill-name">{s.name}</span>
              <span className="skill-desc">{s.description}</span>
            </li>
          ))}
        </ul>
        <h4>Claude only · {claudeOnly.length}</h4>
        <p className="settings-intro">These need tools only Claude has (its apps, connectors or helper agents). Use them in a Claude Code session.</p>
        <ul className="skill-list dim">
          {claudeOnly.map((s) => (
            <li key={s.name}>
              <span className="skill-name">{s.name}</span>
              <span className="skill-desc">{s.description}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

type SetupStep = "idle" | "typing" | "saying" | "saving";

/**
 * Talk-mode approval passphrase. The typed phrase lives only in this component while it is set
 * up; E.V checks that speech recognition hears it three times, then stores only a hash.
 */
export function PassphraseSettings() {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [step, setStep] = useState<SetupStep>("idle");
  // One word per box, so words can never run together or get mixed up.
  const [words, setWords] = useState<string[]>([]);
  const [current, setCurrent] = useState("");
  const [reveal, setReveal] = useState(false);
  const phrase = words.join(" ");
  const [heardOk, setHeardOk] = useState(0);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const SAYS = 3;
  const MIN_WORDS = 2;
  const MAX_WORDS = 4;

  useEffect(() => {
    void refreshPassphraseStatus().then(setSaved);
    return () => dictation.cancel();
  }, []);

  const addWord = () => {
    const word = current.trim();
    if (!word) return;
    setWords((w) => [...w, word]);
    setCurrent("");
  };
  const startSaying = () => {
    if (current.trim()) addWord();
    setStep("saying");
  };
  const total = words.length + (current.trim() ? 1 : 0);

  const reset = () => {
    dictation.cancel();
    setStep("idle");
    setWords([]);
    setCurrent("");
    setReveal(false);
    setHeardOk(0);
    setRecording(false);
    setMessage(null);
  };

  const toggleRecording = async () => {
    if (!recording) {
      setMessage(null);
      try {
        await dictation.start("passphrase-setup");
        setRecording(true);
      } catch (err) {
        setMessage({ ok: false, text: `Microphone unavailable: ${String(err)}` });
      }
      return;
    }
    setRecording(false);
    setBusy(true);
    try {
      const heard = await dictation.stop();
      if (!heard || /^\[?(blank_audio|silence|no speech)\]?$/i.test(heard.trim())) {
        setMessage({ ok: false, text: "Heard nothing — the microphone picked up silence. Check the level bar moves while you speak, then try again." });
      } else if (await passphraseMatches(heard, phrase)) {
        const count = heardOk + 1;
        setHeardOk(count);
        if (count >= SAYS) {
          setStep("saving");
          await passphraseSet(phrase);
          setSaved(await refreshPassphraseStatus());
          reset();
          setMessage({ ok: true, text: "Passphrase saved. Use it in Talk mode to approve actions." });
        } else {
          setMessage({ ok: true, text: `Heard “${heard}” — correct (${count} of ${SAYS}).` });
        }
      } else {
        setMessage({ ok: false, text: `Heard "${heard}" — that doesn't match. Try again, or pick clearer words.` });
      }
    } catch (err) {
      setStep((s) => (s === "saving" ? "saying" : s));
      setMessage({ ok: false, text: String(err) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    await passphraseClear();
    setSaved(await refreshPassphraseStatus());
    setMessage({ ok: true, text: "Passphrase removed. Talk mode will ask you to tap Approve." });
  };

  return (
    <div className="settings-card passphrase-card">
      <h4>Approval passphrase · Talk mode</h4>
      <p className="settings-intro">
        In Talk mode, say all your words together, in order, to approve — every approval needs the full passphrase; one word alone
        never works. Set it up in three steps: type each word → say them together 3 times so E.V learns to hear them → saved.
        Only a scrambled hash is kept, in your Mac's Keychain, and it's never sent to any AI.
      </p>
      <div className={`status-line ${saved ? "ok" : "bad"}`}>
        <Icon name={saved ? "check" : "alert"} size={14} />
        {saved === null ? "Checking…" : saved ? "Passphrase set" : "No passphrase — Talk mode will ask you to tap Approve"}
      </div>

      {step === "idle" && (
        <div className="passphrase-actions">
          <button className="btn small" onClick={() => setStep("typing")}>
            {saved ? "Change passphrase" : "Set passphrase"}
          </button>
          {saved && (
            <button className="btn small ghost danger" onClick={() => void remove()}>
              Remove
            </button>
          )}
        </div>
      )}

      {step === "typing" && (
        <>
          {words.length > 0 && (
            <div className="passphrase-words" aria-label={`${words.length} words added`}>
              {words.map((w, i) => (
                <span key={i} className="passphrase-word">
                  <Icon name="check" size={11} /> Word {i + 1}: {reveal ? w : "•".repeat(Math.max(4, w.length))}
                </span>
              ))}
              <button className="link-btn" onClick={() => setReveal((r) => !r)}>
                {reveal ? "Hide" : "Show"}
              </button>
            </div>
          )}
          {words.length < MAX_WORDS && (
            <label className="field">
              <span>
                Word {words.length + 1}
                {words.length >= MIN_WORDS ? " (optional)" : ""} · one word, no spaces
              </span>
              <input
                type={reveal ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                autoFocus
                value={current}
                onChange={(e) => {
                  // A space finishes the word and moves on to the next box.
                  const parts = e.target.value.split(/\s+/);
                  const done = parts.slice(0, -1).filter(Boolean);
                  if (done.length) setWords((w) => [...w, ...done].slice(0, MAX_WORDS));
                  setCurrent(parts[parts.length - 1]);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (words.length + 1 >= MIN_WORDS && !current.trim() ? startSaying : addWord)();
                }}
              />
            </label>
          )}
          <p className="settings-intro">
            {total < MIN_WORDS
              ? `Add at least ${MIN_WORDS} words — pick ones you'd never say by accident, e.g. two unrelated words and a number.`
              : "You can add another word for extra safety, or move on and say them."}
          </p>
          <div className="passphrase-actions">
            <button className="btn small ghost" onClick={reset}>
              Cancel
            </button>
            {words.length > 0 && (
              <button className="btn small ghost" onClick={() => (setCurrent(words[words.length - 1]), setWords((w) => w.slice(0, -1)))}>
                Back
              </button>
            )}
            {words.length < MAX_WORDS && (
              <button className="btn small ghost" disabled={!current.trim()} onClick={addWord}>
                Next word
              </button>
            )}
            <button className="btn small" disabled={total < MIN_WORDS} onClick={startSaying}>
              Done — say it {SAYS} times
            </button>
          </div>
        </>
      )}

      {(step === "saying" || step === "saving") && (
        <>
          <p className="settings-intro">
            Press the button, say all {words.length} words together in order, then press Stop. E.V checks it heard every word.
          </p>
          <div className="passphrase-progress" aria-label={`${heardOk} of ${SAYS} heard correctly`}>
            {Array.from({ length: SAYS }, (_, i) => (
              <span key={i} className={i < heardOk ? "done" : ""} />
            ))}
          </div>
          <div className="passphrase-stage" role="status">
            {recording ? (
              <>
                <MicLevel /> Listening — say all {words.length} words, then press Stop.
              </>
            ) : busy ? (
              <>
                <span className="spinner small" /> Checking what I heard…
              </>
            ) : (
              `${heardOk} of ${SAYS} heard correctly so far.`
            )}
          </div>
          {message && <div className={`status-line ${message.ok ? "ok" : "bad"}`}>{message.text}</div>}
          <div className="passphrase-actions">
            <button className="btn small ghost" onClick={reset} disabled={busy}>
              Cancel
            </button>
            <button className="btn small ghost" onClick={() => (dictation.cancel(), setRecording(false), setHeardOk(0), setWords([]), setCurrent(""), setStep("typing"))} disabled={busy}>
              Pick different words
            </button>
            <button className={`btn small${recording ? " recording" : ""}`} onClick={() => void toggleRecording()} disabled={busy}>
              {busy ? <span className="spinner small" /> : <Icon name="mic" size={12} />}
              {recording ? "Stop" : `Say all ${words.length} words (${heardOk + 1} of ${SAYS})`}
            </button>
          </div>
        </>
      )}

      {message && step !== "saying" && <div className={`status-line ${message.ok ? "ok" : "bad"}`}>{message.text}</div>}
    </div>
  );
}

/** Live microphone level, so the user can see their voice is reaching E.V. */
function MicLevel() {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      setLevel(Math.min(1, audioEngine.micLevel() * 4));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <span className="mic-level" aria-label={`Microphone level ${Math.round(level * 100)}%`}>
      <span style={{ width: `${Math.round(level * 100)}%` }} />
    </span>
  );
}

const KIND_LABELS: Record<MemoryKind, string> = {
  about: "About me",
  preference: "Preferences",
  rule: "Rules",
  lesson: "Lessons",
  word: "My words",
  note: "Notes",
};
const KIND_ORDER = Object.keys(KIND_LABELS) as MemoryKind[];

const shortDate = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** Everything E.V has learned: search, edit, add and delete. Saved encrypted on this Mac. */
export function MemorySettings() {
  const vault = useVault();
  const chats = useChats((s) => s.chats);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "gideon" | "chat">("all");
  const [newText, setNewText] = useState("");
  const [newKind, setNewKind] = useState<MemoryKind>("about");
  const [notice, setNotice] = useState<string | null>(null);

  const chatTitle = (id?: string) => chats.find((c) => c.id === id)?.title ?? "a closed chat";
  const shown = vault.memories.filter(
    (m) => (scope === "all" || m.scope === scope) && (!query.trim() || m.text.toLowerCase().includes(query.trim().toLowerCase())),
  );

  const add = async () => {
    const text = newText.trim();
    if (!text) return;
    if (await looksSecret(text)) {
      setNotice("Not saved: that looks like a password, key, code or card number. E.V never stores those.");
      return;
    }
    vault.remember({ text, kind: newKind, scope: "gideon" });
    setNewText("");
    setNotice(null);
  };

  return (
    <div className="settings-card memory-settings">
      <h4>Memory</h4>
      <p className="settings-intro">
        What you've taught E.V. <b>E.V memory</b> is read by every AI in every chat; <b>chat memory</b> only by its own chat and is deleted with
        it. Teach it by talking (“Remember I live in Springfield”, “From now on…”, “That's wrong — …”) or add it here. Stored encrypted on this Mac with
        the key in your Keychain; changes save automatically.
      </p>
      <div className={`status-line ${vault.loaded ? "ok" : "bad"}`}>
        <Icon name={vault.loaded ? "check" : "alert"} size={14} />
        {vault.loaded ? `${vault.memories.length} memories · encrypted on this Mac` : vault.error ?? "Opening memory…"}
      </div>
      {vault.loaded && (
        <>
          <div className="memory-toolbar">
            <input placeholder="Search memory" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search memory" />
            <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} aria-label="Which memory">
              <option value="all">All</option>
              <option value="gideon">E.V memory</option>
              <option value="chat">Chat memory</option>
            </select>
          </div>
          {shown.length === 0 && <div className="key-empty muted">{vault.memories.length ? "Nothing matches." : "Nothing learned yet."}</div>}
          {KIND_ORDER.map((kind) => {
            const items = shown.filter((m) => m.kind === kind);
            if (!items.length) return null;
            return (
              <section key={kind} className="memory-group">
                <h5>{KIND_LABELS[kind]}</h5>
                <ul>
                  {items.map((m) => (
                    <li key={m.id} className="memory-row">
                      <textarea
                        defaultValue={m.text}
                        rows={Math.min(4, Math.ceil(m.text.length / 70) || 1)}
                        aria-label="Memory"
                        onBlur={(e) => {
                          const text = e.target.value.trim();
                          if (text && text !== m.text) vault.updateMemory(m.id, { text });
                        }}
                      />
                      <div className="memory-meta">
                        <select value={m.kind} onChange={(e) => vault.updateMemory(m.id, { kind: e.target.value as MemoryKind })} aria-label="Kind">
                          {KIND_ORDER.map((k) => (
                            <option key={k} value={k}>
                              {KIND_LABELS[k]}
                            </option>
                          ))}
                        </select>
                        <span>{m.scope === "gideon" ? "E.V memory" : `Chat: ${chatTitle(m.chatId)}`}</span>
                        <span>
                          Learned {shortDate(m.createdAt)}
                          {m.chatTitle ? ` in “${m.chatTitle}”` : ""}
                        </span>
                        <button className="icon-btn ghost" title="Delete this memory" onClick={() => vault.forget(m.id)}>
                          <Icon name="trash" size={13} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          <h5>Add a memory</h5>
          <div className="memory-add">
            <input
              placeholder="e.g. Lives in Springfield, California"
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void add()}
            />
            <select value={newKind} onChange={(e) => setNewKind(e.target.value as MemoryKind)} aria-label="Kind">
              {KIND_ORDER.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
            <button className="btn small" onClick={() => void add()} disabled={!newText.trim()}>
              Add
            </button>
          </div>
          {notice && <div className="status-line bad">{notice}</div>}
        </>
      )}
    </div>
  );
}

const REPEAT_LABELS: Record<Repeat, string> = {
  none: "Once",
  daily: "Every day",
  weekdays: "Weekdays",
  weekly: "Every week",
  monthly: "Every month",
  yearly: "Every year",
};

/** Events the user added, with reminders while E.V is open. */
export function ScheduleSettings({ draft, update }: { draft: Settings; update: Update }) {
  const vault = useVault();
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [repeat, setRepeat] = useState<Repeat>("none");
  const now = Date.now();
  const soon = upcoming(vault.schedule, now - 3_600_000, now + 30 * 86_400_000);

  const add = () => {
    if (!title.trim() || !start) return;
    vault.addEvent({ title: title.trim(), start: start.replace("T", " "), timeZone: userTimeZone(), repeat });
    setTitle("");
    setStart("");
    setRepeat("none");
  };

  return (
    <div className="settings-card schedule-settings">
      <h4>Schedule</h4>
      <p className="settings-intro">
        Only events you add — by saying “Add gym at 6 PM tomorrow” in any chat, or here. E.V never adds plans you just mention. Reminders show
        while E.V is open; changes save automatically.
      </p>
      <label className="field">
        <span>Early reminder</span>
        <select
          value={draft.reminders.leadMinutes}
          onChange={(e) => update((d) => void (d.reminders.leadMinutes = Number(e.target.value)))}
        >
          {[0, 5, 10, 15, 30, 60].map((m) => (
            <option key={m} value={m}>
              {m === 0 ? "Only at the event time" : `${m} minutes before, and at the event time`}
            </option>
          ))}
        </select>
      </label>

      <h5>Next 30 days</h5>
      {soon.length === 0 && <div className="key-empty muted">Nothing scheduled.</div>}
      <ul className="schedule-list">
        {soon.slice(0, 50).map((o) => (
          <li key={`${o.event.id}@${o.at}`}>{describeEvent(o.event, o.at)}</li>
        ))}
      </ul>

      <h5>All events</h5>
      <ul className="schedule-events">
        {vault.schedule.map((e) => (
          <li key={e.id} className="schedule-row">
            <input defaultValue={e.title} aria-label="Title" onBlur={(ev) => ev.target.value.trim() && vault.updateEvent(e.id, { title: ev.target.value.trim() })} />
            <input
              type="datetime-local"
              defaultValue={e.start.replace(" ", "T")}
              aria-label="Start"
              onBlur={(ev) => ev.target.value && vault.updateEvent(e.id, { start: ev.target.value.replace("T", " ") })}
            />
            <select value={e.repeat} onChange={(ev) => vault.updateEvent(e.id, { repeat: ev.target.value as Repeat })} aria-label="Repeat">
              {(Object.keys(REPEAT_LABELS) as Repeat[]).map((r) => (
                <option key={r} value={r}>
                  {REPEAT_LABELS[r]}
                </option>
              ))}
            </select>
            <button className="icon-btn ghost" title={`Delete ${e.title}`} onClick={() => vault.removeEvent(e.id)}>
              <Icon name="trash" size={13} />
            </button>
          </li>
        ))}
      </ul>

      <h5>Add an event</h5>
      <div className="schedule-row">
        <input placeholder="Title, e.g. Gym" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="New event title" />
        <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} aria-label="New event start" />
        <select value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)} aria-label="New event repeat">
          {(Object.keys(REPEAT_LABELS) as Repeat[]).map((r) => (
            <option key={r} value={r}>
              {REPEAT_LABELS[r]}
            </option>
          ))}
        </select>
        <button className="btn small" onClick={add} disabled={!title.trim() || !start}>
          Add
        </button>
      </div>
    </div>
  );
}

const LEVEL_LABELS: Record<Level, string> = {
  just: "Just do it",
  plan: "Ask (or inside an approved plan)",
  final: "Always ask, with a preview",
  never: "Never",
};

/** What needs approval. Saving changes needs the passphrase, so nothing else can loosen the rules. */
export function ApprovalsSettings() {
  const rules = useVault((s) => s.rules);
  const loaded = useVault((s) => s.loaded);
  const [draft, setDraft] = useState(rules);
  const [newApp, setNewApp] = useState("");
  const [phrase, setPhrase] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [perms, setPerms] = useState<{ accessibility: boolean; screen: boolean } | null>(null);
  const [hasPassphrase, setHasPassphrase] = useState<boolean | null>(null);

  useEffect(() => setDraft(rules), [rules]);
  useEffect(() => {
    const check = () => void macPermissions().then(setPerms, () => setPerms(null));
    check();
    void refreshPassphraseStatus().then(setHasPassphrase);
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);

  const changed = JSON.stringify(draft) !== JSON.stringify(rules);
  const save = async () => {
    if (!hasPassphrase) {
      setMessage({ ok: false, text: "Set your passphrase first (Settings → Voice) — changing these rules needs it." });
      return;
    }
    if (!(await passphraseCheck(phrase).catch(() => false))) {
      setMessage({ ok: false, text: "That's not your passphrase. The rules weren't changed." });
      return;
    }
    useVault.getState().setRules(draft);
    setPhrase("");
    setMessage({ ok: true, text: "Approval rules saved." });
  };

  if (!loaded) return <div className="settings-card"><div className="status-line bad">Approval rules are stored with your memory, which couldn't be opened.</div></div>;

  return (
    <div className="settings-card approvals-settings">
      <h4>Approvals</h4>
      <p className="settings-intro">
        What every AI in E.V may do on your Mac without asking. Jobs show you a plan first — approve it once and everything inside it runs; anything
        outside it asks again. Final steps (send, delete, install) always show a preview. Emergency stop: <b>⌘⇧Esc</b> anywhere, or Esc twice in E.V.
      </p>

      <h5>macOS permissions</h5>
      <div className="perm-row">
        <span className={`status-line ${perms?.accessibility ? "ok" : "bad"}`}>
          <Icon name={perms?.accessibility ? "check" : "alert"} size={13} /> Accessibility — read and control app windows
        </span>
        {!perms?.accessibility && (
          <button className="btn small" onClick={() => void macRequestPermission("accessibility")}>
            Grant access
          </button>
        )}
      </div>
      <div className="perm-row">
        <span className={`status-line ${perms?.screen ? "ok" : "bad"}`}>
          <Icon name={perms?.screen ? "check" : "alert"} size={13} /> Screen Recording — see app windows
        </span>
        {!perms?.screen && (
          <button className="btn small" onClick={() => void macRequestPermission("screen")}>
            Grant access
          </button>
        )}
      </div>

      {perms && (!perms.accessibility || !perms.screen) && (
        <p className="settings-intro">
          Click Grant access, switch <b>E.V</b> on in the list macOS opens, then come back here — this page re-checks automatically. If it still
          shows as off, quit E.V (⌘Q) and open it again.
        </p>
      )}

      <h5>Rules</h5>
      <ul className="approval-rules">
        {(Object.entries(CATEGORIES) as [Category, (typeof CATEGORIES)[Category]][])
          .filter(([, info]) => !info.hidden)
          .map(([key, info]) => (
            <li key={key} className="approval-rule">
              <div>
                <span className="approval-label">{info.label}</span>
                {info.detail && <span className="approval-detail">{info.detail}</span>}
              </div>
              <select
                value={draft.levels[key]}
                disabled={info.locked}
                aria-label={info.label}
                onChange={(e) => setDraft({ ...draft, levels: { ...draft.levels, [key]: e.target.value as Level } })}
              >
                {(Object.keys(LEVEL_LABELS) as Level[]).map((level) => (
                  <option key={level} value={level}>
                    {LEVEL_LABELS[level]}
                    {info.locked ? " (locked)" : ""}
                  </option>
                ))}
              </select>
            </li>
          ))}
      </ul>

      <AlwaysApprovedList />

      <h5>Never-touch apps</h5>
      <p className="settings-intro">E.V won't open, look at or control these. Money apps are always blocked.</p>
      <div className="never-apps">
        {draft.neverApps.map((app) => (
          <span key={app} className="never-app">
            {app}
            <button className="icon-btn ghost" title={`Allow ${app} again`} onClick={() => setDraft({ ...draft, neverApps: draft.neverApps.filter((a) => a !== app) })}>
              <Icon name="close" size={11} />
            </button>
          </span>
        ))}
      </div>
      <div className="memory-add">
        <input placeholder="App name, e.g. Mail" value={newApp} onChange={(e) => setNewApp(e.target.value)} />
        <button
          className="btn small"
          disabled={!newApp.trim()}
          onClick={() => {
            setDraft({ ...draft, neverApps: [...new Set([...draft.neverApps, newApp.trim()])] });
            setNewApp("");
          }}
        >
          Add
        </button>
      </div>

      {changed && (
        <div className="approval-save">
          <input type="password" placeholder="Your passphrase" value={phrase} autoComplete="off" onChange={(e) => setPhrase(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
          <button className="btn small ghost" onClick={() => (setDraft(rules), setMessage(null))}>
            Cancel
          </button>
          <button className="btn small" onClick={() => void save()} disabled={!phrase.trim()}>
            Save rules
          </button>
        </div>
      )}
      {message && <div className={`status-line ${message.ok ? "ok" : "bad"}`}>{message.text}</div>}
    </div>
  );
}

/** Everything approved with "Approve always". Removing one makes E.V ask again next time. */
function AlwaysApprovedList() {
  const always = useVault((s) => s.always);
  return (
    <>
      <h5>Always approved</h5>
      <p className="settings-intro">
        Things you approved with “Approve always” (or your passphrase followed by “always”). Remove one and E.V asks again next time;
        anything not listed here always asks.
      </p>
      {always.length === 0 && <div className="key-empty muted">Nothing yet.</div>}
      <ul className="always-list">
        {[...always]
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((rule) => (
            <li key={rule.key} className="always-row">
              <div>
                <span className="approval-label">{rule.label}</span>
                <span className="approval-detail">
                  Approved {new Date(rule.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · used {rule.uses}{" "}
                  {rule.uses === 1 ? "time" : "times"}
                  {rule.lastUsed ? ` · last ${new Date(rule.lastUsed).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
                </span>
              </div>
              <button className="btn small ghost" onClick={() => useVault.getState().removeAlways(rule.key)}>
                Remove
              </button>
            </li>
          ))}
      </ul>
    </>
  );
}

/** Everything E.V did on the Mac, newest first. */
export function ActivitySettings() {
  const activity = useVault((s) => s.activity);
  const [query, setQuery] = useState("");
  const shown = [...activity]
    .reverse()
    .filter((a) => !query.trim() || `${a.title} ${a.chat} ${a.detail}`.toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, 300);
  return (
    <div className="settings-card activity-settings">
      <h4>Activity</h4>
      <p className="settings-intro">Every action E.V took on your Mac, with the result. Kept encrypted on this Mac (last 2,000).</p>
      <div className="memory-toolbar">
        <input placeholder="Search activity" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn small ghost" onClick={() => useVault.getState().clearActivity()} disabled={!activity.length}>
          Clear
        </button>
      </div>
      {shown.length === 0 && <div className="key-empty muted">Nothing yet.</div>}
      <ul className="activity-list">
        {shown.map((a, i) => (
          <li key={`${a.at}-${i}`} className={`activity-row ${a.outcome}`}>
            <span className="activity-time">{new Date(a.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
            <span className="activity-outcome">{a.outcome}</span>
            <span className="activity-title">{a.title}</span>
            {a.chat && <span className="activity-chat">{a.chat}</span>}
            {a.detail && <span className="activity-detail">{a.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Hold to talk ──────────────────────────────────────────────────────────────

/** A pressed key combo as a shortcut, or null when it isn't one E.V can watch. */
function comboFrom(e: KeyboardEvent): string | null {
  const code = e.code;
  const key = /^Key([A-Z])$/.exec(code)?.[1]?.toLowerCase() ?? /^Digit(\d)$/.exec(code)?.[1] ?? /^F([1-9]|1[0-2])$/.exec(code)?.[0]?.toLowerCase() ??
    ({ Space: "space", Enter: "return", Tab: "tab", Backquote: "`", Minus: "-", Equal: "=", Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\" } as Record<string, string>)[code];
  if (!key) return null;
  const mods = [e.ctrlKey && "control", e.altKey && "option", e.shiftKey && "shift", e.metaKey && "command"].filter(Boolean) as string[];
  if (!mods.length && !key.startsWith("f")) return null;
  return [...mods, key].join("+");
}

export function HoldToTalkSettings({ draft, update }: { draft: Settings; update: Update }) {
  const hold = draft.voice.holdToTalk;
  const error = useHoldToTalk((s) => s.error);
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState("");
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRecording(false);
      if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
      const combo = comboFrom(e);
      if (!combo) return setHint("Use at least one of ⌃ ⌥ ⇧ ⌘ with a key, or an F-key.");
      update((d) => void (d.voice.holdToTalk = { ...d.voice.holdToTalk, shortcut: combo }));
      setHint("");
      setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, update]);
  const set = (patch: Partial<Settings["voice"]["holdToTalk"]>) => update((d) => void (d.voice.holdToTalk = { ...d.voice.holdToTalk, ...patch }));
  const known = SINGLE_KEYS.some((k) => k.id === hold.shortcut) || COMBOS.includes(hold.shortcut);
  return (
    <div className="settings-card">
      <h4>Hold to talk</h4>
      <label className="check-row">
        <input type="checkbox" checked={hold.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span>Hold a shortcut in any app, say what you need, let go — E.V does it. Works with E.V hidden.</span>
      </label>
      <label className="field">
        <span>Shortcut</span>
        <select value={hold.shortcut} disabled={!hold.enabled} onChange={(e) => set({ shortcut: e.target.value })}>
          <optgroup label="One key">
            {SINGLE_KEYS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Key combo">
            {COMBOS.map((c) => (
              <option key={c} value={c}>
                {shortcutLabel(c)}
              </option>
            ))}
            {!known && <option value={hold.shortcut}>{shortcutLabel(hold.shortcut)}</option>}
          </optgroup>
        </select>
      </label>
      <div className="settings-row">
        <button className="btn small ghost" disabled={!hold.enabled} onClick={() => setRecording((r) => !r)}>
          {recording ? "Press your combo… (Esc to cancel)" : "Record your own combo"}
        </button>
        {hint && <span className="muted">{hint}</span>}
      </div>
      <label className="check-row">
        <input type="checkbox" checked={hold.speak} disabled={!hold.enabled} onChange={(e) => set({ speak: e.target.checked })} />
        <span>Speak the answer out loud</span>
      </label>
      <p className="settings-intro">
        It goes to the chat you used last (or a new one if that chat is busy). Esc while holding cancels. A single key like fn still works normally with
        other keys (fn+Delete): only holding it on its own talks. Speech is turned into text on your Mac.
      </p>
      {hold.enabled && error && <p className="settings-error">{error}</p>}
    </div>
  );
}

// ── Learned tasks ─────────────────────────────────────────────────────────────

/** Tasks E.V repeats with no AI; each can be removed. */
export function LearnedTasksSettings() {
  const learned = useVault((s) => s.learned);
  return (
    <div className="settings-card">
      <h4>Learned tasks</h4>
      <p className="settings-intro">
        When E.V finishes a task on your Mac and every step was confirmed, it saves the steps. Asking the same thing again repeats them instantly with no
        AI (no tokens). Sends, deletes and anything you had to approve are never saved. If a saved task stops working, E.V asks the AI and learns the new
        way. You can also say “forget that shortcut”.
      </p>
      {learned.length === 0 && <div className="key-empty muted">Nothing learned yet.</div>}
      <ul className="always-list">
        {[...learned]
          .sort((a, b) => (b.lastUsed ?? b.createdAt) - (a.lastUsed ?? a.createdAt))
          .map((task) => (
            <li key={task.id} className="always-row">
              <div>
                <span className="approval-label">“{task.request}”</span>
                <span className="approval-detail">
                  {task.steps.filter((s) => s.tool !== "wait").length} steps · learned{" "}
                  {new Date(task.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · used {task.uses}{" "}
                  {task.uses === 1 ? "time" : "times"}
                </span>
              </div>
              <button className="btn small ghost" onClick={() => useVault.getState().forgetLearned(task.id)}>
                Remove
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}

// ── Approval shortcuts ────────────────────────────────────────────────────────

/** One key combo, recorded by pressing it. */
function ComboField({ label, value, onChange }: { label: string; value: string; onChange: (combo: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState("");
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRecording(false);
      if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
      const combo = comboFrom(e);
      if (!combo || !combo.includes("+")) return setHint("Use at least one of ⌃ ⌥ ⇧ ⌘ with a key.");
      onChange(combo);
      setHint("");
      setRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onChange]);
  return (
    <div className="settings-row">
      <span className="combo-label">{label}</span>
      <button className={`btn small ghost combo-key${recording ? " recording" : ""}`} onClick={() => setRecording((r) => !r)}>
        {recording ? "Press the keys… (Esc cancels)" : shortcutLabel(value)}
      </button>
      {hint && <span className="muted">{hint}</span>}
    </div>
  );
}

/** Approve / approve always / cancel from any app, while an approval is waiting. */
export function ApprovalKeysSettings({ draft, update }: { draft: Settings; update: Update }) {
  const error = useApprovalKeys((s) => s.error);
  const set = (key: keyof Settings["approvalKeys"]) => (combo: string) => update((d) => void (d.approvalKeys = { ...d.approvalKeys, [key]: combo }));
  const keys = draft.approvalKeys;
  const clash = new Set([keys.approve, keys.always, keys.cancel]).size < 3;
  return (
    <div className="settings-card">
      <h4>Approval shortcuts</h4>
      <p className="settings-intro">
        When E.V needs your OK it shows in your Vorssaint notch (or a small popup at the top right when Vorssaint isn't running). These keys answer it
        from any app; they only work while an approval is waiting, so they never take keys from other apps. Click one and press the new combo.
      </p>
      <ComboField label="Approve" value={keys.approve} onChange={set("approve")} />
      <ComboField label="Approve always" value={keys.always} onChange={set("always")} />
      <ComboField label="Cancel" value={keys.cancel} onChange={set("cancel")} />
      {clash && <p className="settings-error">Each shortcut needs its own combo.</p>}
      {error && <p className="settings-error">{error}</p>}
    </div>
  );
}

/** The quick panel: one E.V chat in a small window over any app. */
export function QuickPanelSettings({ draft, update }: { draft: Settings; update: Update }) {
  const error = useQuickPanel((s) => s.error);
  const keys = [draft.voice.holdToTalk.enabled ? draft.voice.holdToTalk.shortcut : "", draft.approvalKeys.approve, draft.approvalKeys.always, draft.approvalKeys.cancel];
  return (
    <div className="settings-card">
      <h4>Quick panel</h4>
      <p className="settings-intro">
        Press the shortcut in any app to open a small E.V chat at the top of the screen — type a task or question without opening E.V. ☰ switches between all your chats.
        Esc or the shortcut again hides it. While it's open, hold to talk types into it so you can check before sending. Click the key and press a new combo.
      </p>
      <ComboField label="Open / hide" value={draft.panel.shortcut} onChange={(combo) => update((d) => void (d.panel = { ...d.panel, shortcut: combo }))} />
      {keys.includes(draft.panel.shortcut) && <p className="settings-error">That combo is already used by another E.V shortcut.</p>}
      {error && <p className="settings-error">{error}</p>}
    </div>
  );
}
