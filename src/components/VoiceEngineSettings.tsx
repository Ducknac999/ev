import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { audioEngine } from "../audio/engine";
import {
  sttStatus,
  ttsSynthesize,
  ttsVoices,
  voiceEngineStatus,
  voiceModelsDownload,
  type SttStatus,
  type Voice,
  type VoiceEngineStatus,
  type VoiceModelProgress,
} from "../lib/ipc";
import type { Settings } from "../types";
import { Icon } from "./Icon";

type Update = (fn: (d: Settings) => void) => void;

const PREVIEW = "Good evening. Your dentist appointment is tomorrow at ten in the morning. Shall I set a reminder?";
/** Google's Live voices closest to E.V's character (calm, smooth, clear). */
const LIVE_VOICES: [string, string][] = [
  ["Despina", "Despina · smooth"],
  ["Sulafat", "Sulafat · warm"],
  ["Kore", "Kore · firm"],
  ["Erinome", "Erinome · clear"],
  ["Achernar", "Achernar · soft"],
  ["Aoede", "Aoede · breezy"],
];
const mb = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

/** The on-device voice engine: model downloads, E.V's voice, speed and the whisper fallback. */
export function VoiceEngineSettings({ draft, update }: { draft: Settings; update: Update }) {
  const [status, setStatus] = useState<VoiceEngineStatus | null>(null);
  const [progress, setProgress] = useState<Record<string, VoiceModelProgress>>({});
  const [error, setError] = useState("");
  const [macVoices, setMacVoices] = useState<Voice[]>([]);
  const [stt, setStt] = useState<SttStatus | null>(null);
  const [previewing, setPreviewing] = useState("");

  const refresh = () => voiceEngineStatus().then(setStatus, () => setStatus(null));

  useEffect(() => {
    void refresh();
    ttsVoices().then(setMacVoices, () => setMacVoices([]));
    const off = listen<VoiceModelProgress>("voice-models", (event) => {
      setProgress((p) => ({ ...p, [event.payload.id]: event.payload }));
      if (event.payload.stage === "installed" || event.payload.stage === "failed") void refresh();
    });
    return () => void off.then((stop) => stop());
  }, []);

  useEffect(() => {
    sttStatus(draft.voice.sttModelPath).then(setStt, () => setStt(null));
  }, [draft.voice.sttModelPath, status]);

  const missing = status?.models.filter((m) => !m.installed) ?? [];
  const downloading = status?.downloading || Object.values(progress).some((p) => p.stage === "downloading" || p.stage === "checking");
  const ttsReady = status?.models.find((m) => m.id === "tts")?.installed ?? false;

  const download = async () => {
    setError("");
    setStatus((s) => (s ? { ...s, downloading: true } : s));
    try {
      await voiceModelsDownload();
    } catch (err) {
      setError(String(err));
    }
    await refresh();
  };

  const preview = async (voice: string) => {
    setPreviewing(voice);
    try {
      audioEngine.duck(false);
      await audioEngine.play(await ttsSynthesize(PREVIEW, voice, draft.voice.ttsRate));
    } catch (err) {
      setError(`Preview failed: ${String(err)}`);
    } finally {
      setPreviewing("");
    }
  };

  return (
    <div className="settings-card">
      <h4>On-device voice engine</h4>
      <p className="settings-intro">
        Runs entirely on this Mac, free and offline: Silero hears when someone is speaking, Parakeet turns speech into text, and
        Kokoro is E.V's voice. Nothing you say leaves the Mac until it's a request for an AI.
      </p>
      {status?.models.map((m) => {
        const p = progress[m.id];
        const pct = p && p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
        return (
          <div key={m.id} className="engine-row">
            <span className={`status-line ${m.installed ? "ok" : "bad"}`}>
              <Icon name={m.installed ? "check" : "alert"} size={14} />
              {m.label}
            </span>
            {m.installed ? (
              <span className="engine-note">Installed</span>
            ) : p && (p.stage === "downloading" || p.stage === "checking") ? (
              <>
                <span className="usage-meter tone-ok" aria-label={`${m.label} ${pct}%`}>
                  <span className="usage-fill" style={{ width: `${pct}%` }} />
                </span>
                <span className="engine-note">{p.stage === "checking" ? "Checking…" : `${mb(p.done)} / ${mb(p.total)}`}</span>
              </>
            ) : (
              <span className="engine-note">{p?.stage === "failed" ? "Failed" : `Not installed · ${mb(m.bytes)}`}</span>
            )}
          </div>
        );
      })}
      {missing.length > 0 && (
        <button className="btn primary engine-download" disabled={downloading} onClick={() => void download()}>
          {downloading ? "Downloading…" : `Download ${mb(missing.reduce((n, m) => n + m.bytes, 0))}`}
        </button>
      )}
      {error && <div className="status-line bad">{error}</div>}

      <label className="field">
        <span>E.V's voice</span>
        <div className="engine-voice">
          <select value={draft.voice.ttsVoice} onChange={(e) => update((d) => void (d.voice.ttsVoice = e.target.value))}>
            <optgroup label={ttsReady ? "E.V" : "E.V (download the voice first)"}>
              {status?.voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="macOS voices">
              <option value="system">macOS default</option>
              {macVoices.map((v) => (
                <option key={`${v.name}-${v.locale}`} value={v.name}>
                  {v.name} ({v.locale})
                </option>
              ))}
            </optgroup>
          </select>
          <button className="btn" disabled={previewing !== ""} onClick={() => void preview(draft.voice.ttsVoice)}>
            {previewing ? "Playing…" : "Preview"}
          </button>
        </div>
      </label>
      <label className="field">
        <span>Speaking speed · {Math.round((draft.voice.ttsRate / 185) * 100)}%</span>
        <input
          type="range"
          min={120}
          max={320}
          step={5}
          value={draft.voice.ttsRate}
          onChange={(e) => update((d) => void (d.voice.ttsRate = Number(e.target.value)))}
        />
      </label>

      <h4>Turbo replies · Gemini Live</h4>
      <label className="check-row">
        <input type="checkbox" checked={draft.voice.turbo} onChange={(e) => update((d) => void (d.voice.turbo = e.target.checked))} />
        <span>
          Chat-style answers start sooner, spoken by Google's voice. Tasks, live info and approvals still go the normal way. Only
          the words you said to E.V are sent — never your microphone. If Google's free limit is reached, E.V switches back
          by itself for 30 minutes.
        </span>
      </label>
      <label className="field">
        <span>Turbo voice</span>
        <select disabled={!draft.voice.turbo} value={draft.voice.turboVoice} onChange={(e) => update((d) => void (d.voice.turboVoice = e.target.value))}>
          {LIVE_VOICES.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <h4>Speech recognition</h4>
      <div className={`status-line ${stt?.engine === "parakeet" || (stt?.binary && stt.modelExists) ? "ok" : "bad"}`}>
        <Icon name={stt?.engine === "parakeet" || (stt?.binary && stt.modelExists) ? "check" : "alert"} size={14} />
        {!stt
          ? "Checking…"
          : stt.engine === "parakeet"
            ? draft.voice.sttLanguage === "auto" || draft.voice.sttLanguage === "en"
              ? "Parakeet · on this Mac, kept loaded"
              : `Parakeet is English-only — using whisper.cpp for “${draft.voice.sttLanguage}”`
            : !stt.binary
              ? "Download the engine above (or brew install whisper-cpp)"
              : !stt.modelExists
                ? `Whisper model not found at ${stt.modelPath}`
                : "whisper.cpp (fallback until the engine is downloaded)"}
      </div>
      <label className="field">
        <span>Spoken language</span>
        <input
          className="mono"
          placeholder="auto, en, de, …"
          value={draft.voice.sttLanguage}
          onChange={(e) => update((d) => void (d.voice.sttLanguage = e.target.value))}
        />
      </label>
      <label className="field">
        <span>Whisper model for other languages (ggml)</span>
        <input
          className="mono"
          value={draft.voice.sttModelPath}
          onChange={(e) => update((d) => void (d.voice.sttModelPath = e.target.value))}
        />
      </label>
    </div>
  );
}
