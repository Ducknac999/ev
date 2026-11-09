import { Component, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  macDefaultBrowser,
  macPermissions,
  macRequestPermission,
  onboardInstall,
  onboardPermissions,
  onboardRequestAutomation,
  onboardRequestMicrophone,
  onboardTools,
  passphraseSet,
  passphraseStatus,
  providerModels,
  type OnboardTools,
} from "../lib/ipc";
import { uid } from "../lib/ids";
import { KEY_PAGES, PROVIDER_BASE, PROVIDERS } from "../providers/catalog";
import { fits, LOCAL_MODELS, pullModel } from "../services/localModels";
import { useSettings } from "../store/settings";
import type { KeyedProviderId, Settings } from "../types";
import { Icon, type IconName } from "./Icon";
import { NotchFeatureSwitches } from "./NotchSettings";
import { VoiceEngineSettings } from "./VoiceEngineSettings";

/**
 * The start window: a first-launch walk through everything E.V needs. Every step can be skipped
 * and done later in Settings; nothing here is required to start using E.V.
 */

const STEPS = ["Agents", "API keys", "Local model", "Passphrase", "Permissions", "Voice", "Notch", "Done"] as const;

const KEY_PROVIDERS: KeyedProviderId[] = ["deepseek", "openai", "anthropic", "gemini", "openrouter", "xai", "mistral", "groq"];
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Saves a change to the live settings (always from the latest copy, so steps never undo each other). */
async function change(fn: (s: Settings) => void): Promise<void> {
  const next = structuredClone(useSettings.getState().settings);
  fn(next);
  await useSettings.getState().save(next);
}

function SkipNote() {
  return <p className="ob-skip-note">Skipping is fine — you can do this later in Settings.</p>;
}

function Intro({ onStart }: { onStart: () => void }) {
  return (
    <div className="ob-intro">
      <div className="ob-logo" aria-hidden="true">
        <span className="ob-ring r1" />
        <span className="ob-ring r2" />
        <span className="ob-ring r3" />
        <span className="ob-core" />
      </div>
      <h1 className="ob-title">
        <span>E</span>
        <span>.</span>
        <span>V</span>
      </h1>
      <p className="ob-tagline">Your Mac, one sentence away.</p>
      <button className="btn neon ob-start" onClick={onStart} autoFocus>
        Get started
      </button>
      <p className="ob-fine">Everything stays on this Mac. Takes about two minutes, and every step can be skipped.</p>
    </div>
  );
}

function AgentsStep({ tools, refresh }: { tools: OnboardTools | null; refresh: () => void }) {
  const agents = useSettings((s) => s.settings.agents);
  const [busy, setBusy] = useState<"claude" | "codex" | null>(null);
  const [message, setMessage] = useState("");
  // Defaults from what's installed: one → that one, both → both. Set once, then the user decides.
  const decided = useRef(false);
  useEffect(() => {
    if (!tools || decided.current) return;
    decided.current = true;
    if (tools.claude || tools.codex) void change((s) => void (s.agents = { claude: Boolean(tools.claude), codex: Boolean(tools.codex) }));
  }, [tools]);

  const install = async (name: "claude" | "codex") => {
    setBusy(name);
    setMessage("");
    try {
      await onboardInstall(name);
      await change((s) => void (s.agents = { ...s.agents, [name]: true }));
      setMessage(`${name === "claude" ? "Claude Code" : "Codex"} is installed.`);
    } catch (err) {
      setMessage(String(err));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const card = (name: "claude" | "codex", label: string, about: string) => {
    const installed = Boolean(tools?.[name]);
    const on = agents[name];
    return (
      <div className={`ob-card${on && installed ? " on" : ""}`}>
        <div className="ob-card-head">
          <Icon name="spark" size={16} />
          <strong>{label}</strong>
          <span className={`ob-pill ${installed ? "ok" : ""}`}>{installed ? "Installed" : "Not installed"}</span>
        </div>
        <p className="ob-card-about">{about}</p>
        {installed ? (
          <label className="check-row">
            <input type="checkbox" checked={on} onChange={(e) => void change((s) => void (s.agents = { ...s.agents, [name]: e.target.checked }))} />
            <span>Use {label} in E.V</span>
          </label>
        ) : (
          <button className="btn" disabled={busy !== null} onClick={() => void install(name)}>
            {busy === name ? "Installing…" : `Install ${label}`}
          </button>
        )}
      </div>
    );
  };

  const none = tools && !tools.claude && !tools.codex;
  return (
    <>
      <h2>Coding agents</h2>
      <p className="ob-lead">
        {!tools
          ? "Checking what's on this Mac…"
          : tools.claude && tools.codex
            ? "Both are here, so E.V uses both — switch between them any time."
            : tools.claude
              ? "Claude Code is here, so E.V uses it."
              : tools.codex
                ? "Codex is here, so E.V uses it."
                : "Neither is installed yet. Install one, both, or skip."}
      </p>
      <div className="ob-cards two">
        {card("claude", "Claude Code", "Anthropic's coding agent, on your Claude plan.")}
        {card("codex", "Codex", "OpenAI's coding agent, on your ChatGPT plan.")}
      </div>
      {none && !tools?.npm && <p className="ob-hint">Codex installs with Node.js (nodejs.org) or Homebrew (brew.sh).</p>}
      {message && <p className="ob-hint">{message}</p>}
      <SkipNote />
    </>
  );
}

function KeysStep() {
  const providers = useSettings((s) => s.settings.providers);
  const customBase = useSettings((s) => s.settings.customServer.baseUrl);
  const [open, setOpen] = useState<KeyedProviderId | null>("deepseek");
  const [draft, setDraft] = useState("");
  const [base, setBase] = useState(customBase);
  const [state, setState] = useState<{ busy: boolean; error: string; ok: string }>({ busy: false, error: "", ok: "" });

  const add = async (provider: KeyedProviderId) => {
    const key = draft.trim();
    const address = provider === "custom" ? base.trim() : provider === "gemini" ? GEMINI_BASE : (PROVIDER_BASE[provider] ?? "");
    if ((!key && provider !== "custom") || !address) return;
    setState({ busy: true, error: "", ok: "" });
    try {
      const models = await providerModels(address, key, provider);
      await change((s) => {
        if (provider === "custom") s.customServer.baseUrl = address;
        const p = s.providers[provider];
        if (!p.keys.some((k) => k.key === key)) p.keys.push({ id: uid("key-"), name: `${PROVIDERS[provider].label} ${p.keys.length + 1}`, key: key || "none" });
        const known = new Set(PROVIDERS[provider].models.map((m) => m.id));
        p.customModels = [...new Set([...p.customModels, ...models.filter((m) => !known.has(m))])].slice(0, 120);
        // The first key anywhere also picks the model new chats use.
        const hadAny = Object.values(s.providers).some((x, i) => x.keys.length && Object.keys(s.providers)[i] !== provider);
        const first = PROVIDERS[provider].models[0]?.id ?? models[0];
        if (!hadAny && first) s.defaultModel = { provider, model: first };
      });
      setDraft("");
      setState({ busy: false, error: "", ok: `Key works — ${models.length} model${models.length === 1 ? "" : "s"} available.` });
    } catch (err) {
      setState({ busy: false, error: String(err), ok: "" });
    }
  };

  return (
    <>
      <h2>API keys</h2>
      <p className="ob-lead">Add keys for any AI you use — one, several, or all of them. Each key is checked before it's saved, and stays on this Mac.</p>
      <div className="ob-providers">
        {[...KEY_PROVIDERS, "custom" as const].map((provider) => {
          const count = providers[provider]?.keys.length ?? 0;
          const expanded = open === provider;
          return (
            <div key={provider} className={`ob-provider${expanded ? " open" : ""}`}>
              <button
                className="ob-provider-head"
                onClick={() => {
                  setOpen(expanded ? null : provider);
                  setDraft("");
                  setState({ busy: false, error: "", ok: "" });
                }}
              >
                <span>{PROVIDERS[provider].label}</span>
                {count > 0 && <span className="ob-pill ok">{count} key{count === 1 ? "" : "s"}</span>}
                <Icon name={expanded ? "chevronUp" : "chevron"} size={12} />
              </button>
              {expanded && (
                <div className="ob-provider-body">
                  {provider === "custom" && (
                    <input className="ob-input" placeholder="Server address, e.g. https://my-server.com/v1" value={base} onChange={(e) => setBase(e.target.value)} />
                  )}
                  <div className="ob-row">
                    <input
                      className="ob-input"
                      type="password"
                      placeholder={provider === "custom" ? "Key (leave empty if none)" : "Paste your API key"}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && void add(provider)}
                    />
                    <button className="btn neon" disabled={state.busy} onClick={() => void add(provider)}>
                      {state.busy ? "Checking…" : "Add"}
                    </button>
                  </div>
                  {KEY_PAGES[provider] && (
                    <a className="ob-link" href={KEY_PAGES[provider]} target="_blank" rel="noreferrer">
                      Get a {PROVIDERS[provider].label} key
                    </a>
                  )}
                  {state.error && <p className="ob-error">{state.error}</p>}
                  {state.ok && <p className="ob-ok">{state.ok}</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <SkipNote />
    </>
  );
}

function LocalStep({ tools, refresh }: { tools: OnboardTools | null; refresh: () => void }) {
  const installed = useSettings((s) => s.settings.providers.ollama.customModels);
  const [query, setQuery] = useState("");
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return LOCAL_MODELS.filter((m) => !q || `${m.label} ${m.name} ${m.about}`.toLowerCase().includes(q));
  }, [query]);

  const installOllama = async () => {
    setBusy("ollama");
    setError("");
    try {
      await onboardInstall("ollama");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const install = async (name: string) => {
    const model = name.trim();
    if (!model) return;
    setBusy(model);
    setProgress(0);
    setError("");
    abort.current = new AbortController();
    try {
      await pullModel(model, (fraction) => fraction >= 0 && setProgress(fraction), abort.current.signal);
      await change((s) => {
        const p = s.providers.ollama;
        // Local models need no key; E.V's key pool still wants one entry to run through.
        if (!p.keys.length) p.keys.push({ id: "local", name: "This Mac", key: "ollama" });
        if (!p.customModels.includes(model)) p.customModels.push(model);
        if (!Object.entries(s.providers).some(([id, x]) => id !== "ollama" && x.keys.length)) s.defaultModel = { provider: "ollama", model };
      });
    } catch (err) {
      if (!abort.current?.signal.aborted) setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const ready = tools?.ollamaRunning;
  return (
    <>
      <h2>Local model</h2>
      <p className="ob-lead">Run a free AI model on this Mac — private, offline, no key. It's optional.</p>
      {!ready ? (
        <div className="ob-card">
          <div className="ob-card-head">
            <Icon name="download" size={16} />
            <strong>Ollama</strong>
            <span className="ob-pill">{tools?.ollama ? "Not running" : "Not installed"}</span>
          </div>
          <p className="ob-card-about">Local models run through Ollama, a free app. E.V installs it from ollama.com.</p>
          <button className="btn neon" disabled={busy !== null} onClick={() => void installOllama()}>
            {busy === "ollama" ? "Installing Ollama…" : tools?.ollama ? "Start Ollama" : "Install Ollama"}
          </button>
        </div>
      ) : (
        <>
          <input className="ob-input ob-search" placeholder="Search models…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="ob-models">
            {list.map((m) => {
              const fit = fits(m, tools?.memoryGb ?? 0);
              const has = installed.includes(m.name);
              return (
                <div key={m.name} className="ob-model">
                  <div className="ob-model-text">
                    <strong>{m.label}</strong>
                    <span>
                      {m.about} · {m.gb} GB
                    </span>
                  </div>
                  <span className={`ob-pill ${fit === "fits" ? "ok" : fit === "tight" ? "warn" : "bad"}`}>{fit === "fits" ? "Fits this Mac" : fit === "tight" ? "Tight" : "Too big"}</span>
                  {has ? (
                    <span className="ob-pill ok">Installed</span>
                  ) : busy === m.name ? (
                    <span className="ob-progress">
                      <span style={{ width: `${Math.round(progress * 100)}%` }} />
                    </span>
                  ) : (
                    <button className="btn small" disabled={busy !== null || fit === "too big"} onClick={() => void install(m.name)}>
                      Install
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <div className="ob-row">
            <input className="ob-input" placeholder="Any other model from ollama.com/library, e.g. qwen3:30b" value={custom} onChange={(e) => setCustom(e.target.value)} />
            <button className="btn" disabled={busy !== null || !custom.trim()} onClick={() => void install(custom)}>
              Install
            </button>
          </div>
        </>
      )}
      {error && <p className="ob-error">{error}</p>}
      <SkipNote />
    </>
  );
}

function PassphraseStep() {
  const [has, setHas] = useState(false);
  const [one, setOne] = useState("");
  const [two, setTwo] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => {
    void passphraseStatus().then(setHas).catch(() => {});
  }, []);
  const save = async () => {
    if (one.trim().split(/\s+/).length < 2) return setNote("Use at least two words — something you'd say, not a password.");
    if (one !== two) return setNote("The two don't match.");
    try {
      await passphraseSet(one.trim());
      setHas(true);
      setOne("");
      setTwo("");
      setNote("Saved in your Mac's keychain.");
    } catch (err) {
      setNote(String(err));
    }
  };
  return (
    <>
      <h2>Passphrase</h2>
      <p className="ob-lead">Before E.V sends, deletes or does anything that can't be undone, it asks. Your passphrase lets you approve those by voice. It's kept in your Mac's keychain.</p>
      {has && <p className="ob-ok">A passphrase is set. You can change it below.</p>}
      <input className="ob-input" type="password" placeholder="Passphrase (two or more words)" value={one} onChange={(e) => setOne(e.target.value)} />
      <input className="ob-input" type="password" placeholder="Type it again" value={two} onChange={(e) => setTwo(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
      <button className="btn neon" disabled={!one || !two} onClick={() => void save()}>
        Save passphrase
      </button>
      {note && <p className="ob-hint">{note}</p>}
      <SkipNote />
    </>
  );
}

function PermissionsStep() {
  const [perms, setPerms] = useState({ accessibility: false, screen: false, microphone: "unknown" as string, browser: false });
  const [browser, setBrowser] = useState("Safari");
  useEffect(() => {
    void macDefaultBrowser().then(setBrowser).catch(() => {});
    const read = () => {
      void Promise.all([macPermissions(), onboardPermissions()])
        .then(([mac, more]) => setPerms((p) => ({ ...p, accessibility: mac.accessibility, screen: mac.screen, microphone: more.microphone })))
        .catch(() => {});
    };
    read();
    const timer = window.setInterval(read, 1500);
    return () => window.clearInterval(timer);
  }, []);
  const row = (done: boolean, title: string, why: string, grant: () => void) => (
    <div className={`ob-perm${done ? " done" : ""}`}>
      <span className="ob-perm-mark">{done ? "✓" : ""}</span>
      <div className="ob-perm-text">
        <strong>{title}</strong>
        <span>{why}</span>
      </div>
      {done ? <span className="ob-pill ok">On</span> : <button className="btn small neon" onClick={grant}>Grant</button>}
    </div>
  );
  return (
    <>
      <h2>Permissions</h2>
      <p className="ob-lead">macOS asks you to allow each one. Click Grant, turn E.V on in the window that opens, and come back — it turns green by itself.</p>
      <div className="ob-perms">
        {row(perms.accessibility, "Accessibility", "Click, type and read app windows for you", () => void macRequestPermission("accessibility"))}
        {row(perms.screen, "Screen Recording", "See your screen when you ask about it", () => void macRequestPermission("screen"))}
        {row(perms.microphone === "granted", "Microphone", "Talk to E.V (voice stays on this Mac)", () => void onboardRequestMicrophone())}
        {row(perms.browser, `${browser} control`, "Switch tabs and work in your browser", () => void onboardRequestAutomation(browser).then((ok) => setPerms((p) => ({ ...p, browser: ok }))))}
      </div>
      <SkipNote />
    </>
  );
}

function VoiceStep() {
  const settings = useSettings((s) => s.settings);
  const update = (fn: (d: Settings) => void) => void change(fn);
  return (
    <>
      <h2>Voice and shortcuts</h2>
      <p className="ob-lead">Download E.V's voice and speech models (they run on this Mac), then choose how you talk to it.</p>
      <div className="ob-voice">
        <VoiceEngineSettings draft={settings} update={update} />
      </div>
      <label className="check-row">
        <input type="checkbox" checked={settings.voice.wakeWord} onChange={(e) => update((d) => void (d.voice.wakeWord = e.target.checked))} />
        <span>Listen for “Hey E.V” in Talk mode</span>
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={settings.voice.holdToTalk.enabled}
          onChange={(e) => update((d) => void (d.voice.holdToTalk = { ...d.voice.holdToTalk, enabled: e.target.checked }))}
        />
        <span>Hold to talk from any app ({settings.voice.holdToTalk.shortcut.replace(/\+/g, " + ")})</span>
      </label>
      <p className="ob-hint">Quick panel from any app: {settings.panel.shortcut.replace(/\+/g, " + ")}. Change any shortcut in Settings → Shortcuts.</p>
      <SkipNote />
    </>
  );
}

/** What the open notch looks like, so people know what they're turning on. */
function NotchPreview() {
  const left: IconName[] = ["chat", "music", "tray", "clipboard", "wave"];
  const right: IconName[] = ["mic", "cup", "split", "expand"];
  return (
    <div className="ob-notch-preview" aria-hidden="true">
      <div className="ob-notch-shape">
        <div className="ob-notch-top">
          <div className="ob-notch-side">
            {left.map((n, i) => (
              <span key={n} className={i === 3 ? "on" : ""}>
                <Icon name={n} size={12} />
              </span>
            ))}
          </div>
          <div className="ob-notch-camera" />
          <div className="ob-notch-side right">
            {right.map((n) => (
              <span key={n}>
                <Icon name={n} size={12} />
              </span>
            ))}
          </div>
        </div>
        <div className="ob-notch-card">
          <i style={{ width: "78%" }} />
          <i style={{ width: "52%" }} />
        </div>
        <div className="ob-notch-card">
          <i style={{ width: "64%" }} />
        </div>
      </div>
    </div>
  );
}

function NotchStep() {
  const settings = useSettings((s) => s.settings);
  const update = (fn: (d: Settings) => void) => void change(fn);
  const on = settings.notch.mode === "ev";
  return (
    <>
      <h2>The notch</h2>
      <p className="ob-lead">
        E.V can live in your Mac's notch (a small pill at the top on Macs without one). Hover it, or use a shortcut, and it opens over any app. Choose what it
        shows — or don't use it at all.
      </p>
      <NotchPreview />
      <label className="check-row switch-row ob-notch-main">
        <span className="switch-text">
          <strong>Use the E.V notch</strong>
          <small>{on ? "On — choose what it shows below." : "Off — E.V works the same without it. Turn it on any time in Settings → Notch."}</small>
        </span>
        <input type="checkbox" checked={on} onChange={(e) => update((d) => void (d.notch.mode = e.target.checked ? "ev" : "off"))} />
      </label>
      {on && (
        <>
          <NotchFeatureSwitches settings={settings} update={update} />
          <label className="check-row switch-row ob-notch-full">
            <span className="switch-text">
              <strong>Step aside in full-screen apps</strong>
              <small>So it never covers an app's top bar. Push the pointer to the top edge to slide it out.</small>
            </span>
            <input type="checkbox" checked={settings.notch.hideInFullscreen} onChange={(e) => update((d) => void (d.notch.hideInFullscreen = e.target.checked))} />
          </label>
        </>
      )}
      <SkipNote />
    </>
  );
}

function DoneStep() {
  const s = useSettings((st) => st.settings);
  const keys = Object.entries(s.providers).filter(([id, p]) => id !== "ollama" && p.keys.length).map(([id]) => PROVIDERS[id as KeyedProviderId].label);
  const items: [boolean, string][] = [
    [s.agents.claude || s.agents.codex, s.agents.claude && s.agents.codex ? "Claude Code and Codex" : s.agents.claude ? "Claude Code" : s.agents.codex ? "Codex" : "No coding agent yet"],
    [keys.length > 0, keys.length ? `Keys: ${keys.join(", ")}` : "No API keys yet"],
    [s.providers.ollama.customModels.length > 0, s.providers.ollama.customModels.length ? `Local: ${s.providers.ollama.customModels.join(", ")}` : "No local model"],
    [s.notch.mode === "ev", s.notch.mode === "ev" ? "The E.V notch is on" : "No notch (turn it on in Settings → Notch)"],
  ];
  return (
    <>
      <div className="ob-done-mark" aria-hidden="true">
        <Icon name="check" size={28} />
      </div>
      <h2>You're set</h2>
      {s.movedFromPersonal && (
        <p className="ob-lead">
          Everything from your other E.V is here: keys, chats, memory and settings, and your open sessions kept running. The old app is still on
          your Mac as a backup — once you've checked, you can move it to the Trash.
        </p>
      )}
      <ul className="ob-summary">
        {items.map(([ok, text]) => (
          <li key={text} className={ok ? "ok" : ""}>
            <span>{ok ? "✓" : "–"}</span> {text}
          </li>
        ))}
      </ul>
      <div className="ob-update-note">
        <Icon name="download" size={14} />
        <span>
          To update E.V later: <strong>Settings → Updates</strong>. It shows what's new and installs it in one click.
        </span>
      </div>
    </>
  );
}

/** One step failing never blanks the window: it says so, and Skip / Continue still work. */
class StepGuard extends Component<{ children: ReactNode }, { failed: string | null }> {
  state = { failed: null as string | null };
  static getDerivedStateFromError(err: unknown) {
    return { failed: err instanceof Error ? err.message : String(err) };
  }
  render() {
    if (this.state.failed)
      return (
        <>
          <h2>This step didn't load</h2>
          <p className="ob-lead">Skip it for now — you can set it up later in Settings.</p>
          <p className="ob-error">{this.state.failed}</p>
        </>
      );
    return this.props.children;
  }
}

export function Onboarding() {
  const start = useSettings.getState().settings.onboardStart;
  const [step, setStep] = useState(typeof start === "number" ? start : -1);
  const [tools, setTools] = useState<OnboardTools | null>(null);
  const refresh = () => void onboardTools().then(setTools).catch(() => {});
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 4000);
    return () => window.clearInterval(timer);
  }, []);
  const finish = () =>
    void change((s) => {
      s.onboarded = true;
      delete s.onboardStart;
    });
  const last = STEPS.length - 1;

  return (
    <div className="ob-backdrop">
      <div className={`ob-window${step < 0 ? " intro" : ""}`} role="dialog" aria-modal="true" aria-label="Set up E.V">
        {step < 0 ? (
          <Intro onStart={() => setStep(0)} />
        ) : (
          <>
            <nav className="ob-steps" aria-label="Setup steps">
              {STEPS.map((name, i) => (
                <button key={name} className={`ob-step${i === step ? " current" : ""}${i < step ? " past" : ""}`} onClick={() => setStep(i)}>
                  <span className="ob-step-dot">{i < step ? "✓" : String.fromCharCode(65 + i)}</span>
                  <span className="ob-step-name">{name}</span>
                </button>
              ))}
            </nav>
            <section className="ob-body" key={step}>
              <StepGuard>
              {step === 0 && <AgentsStep tools={tools} refresh={refresh} />}
              {step === 1 && <KeysStep />}
              {step === 2 && <LocalStep tools={tools} refresh={refresh} />}
              {step === 3 && <PassphraseStep />}
              {step === 4 && <PermissionsStep />}
              {step === 5 && <VoiceStep />}
              {step === 6 && <NotchStep />}
              {step === 7 && <DoneStep />}
              </StepGuard>
            </section>
            <footer className="ob-foot">
              <button className="btn ghost" onClick={() => (step === 0 ? setStep(-1) : setStep(step - 1))}>
                Back
              </button>
              <span className="ob-foot-space" />
              {step < last && (
                <button className="btn ghost" onClick={() => setStep(step + 1)}>
                  Skip
                </button>
              )}
              <button className="btn neon" onClick={() => (step < last ? setStep(step + 1) : finish())}>
                {step < last ? "Continue" : "Start using E.V"}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
