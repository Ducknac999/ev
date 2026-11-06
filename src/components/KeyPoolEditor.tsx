import { useState } from "react";
import { uid } from "../lib/ids";
import { openExternal } from "../lib/ipc";
import { formatReset, keyStatusText, remainingText } from "../lib/usageFormat";
import { modelsFor, PROVIDERS } from "../providers/catalog";
import { keyEngine } from "../providers/keyPool";
import { useChats } from "../store/chats";
import { defaultKeyName } from "../store/settings";
import type { ApiKey, KeyedProviderId, ProviderSettings, Settings } from "../types";
import { Icon } from "./Icon";
import { SourceTag, UsageMeter, useKeyEngine } from "./Usage";

const AI_STUDIO_LIMITS = "https://aistudio.google.com/rate-limit";

function mask(key: string): string {
  return key.length <= 8 ? "•".repeat(key.length) : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Next unused default name, so deleting "Gemini 2" and adding a key gives "Gemini 2" again. */
function nextName(provider: KeyedProviderId, keys: ApiKey[]): string {
  const taken = new Set(keys.map((k) => k.name.toLowerCase()));
  let n = 1;
  while (taken.has(defaultKeyName(provider, n).toLowerCase())) n++;
  return defaultKeyName(provider, n);
}

function DailyLimits({
  provider,
  draft,
  value,
  onChange,
}: {
  provider: KeyedProviderId;
  draft: Settings;
  value: Record<string, number>;
  onChange: (limits: Record<string, number>) => void;
}) {
  const models = modelsFor(provider, draft);
  return (
    <details className="daily-limits">
      <summary>Daily limits per model</summary>
      <p className="settings-intro">
        Google doesn't tell apps how much is left, so E.V counts requests per key against these limits. When a key
        hits its limit, Google reports the real number and E.V uses that from then on. To set them yourself, copy the
        "requests per day" numbers from{" "}
        <a
          href={AI_STUDIO_LIMITS}
          onClick={(e) => {
            e.preventDefault();
            void openExternal(AI_STUDIO_LIMITS);
          }}
        >
          AI Studio → Rate limits
        </a>
        .
      </p>
      <div className="limit-grid">
        {models.map((m) => {
          const effective = keyEngine.dailyLimit(provider, m.id);
          const learned = effective?.source === "learned";
          return (
            <label key={m.id} className="limit-row">
              <span className="limit-model">{m.label}</span>
              <input
                className="mono"
                type="number"
                min={0}
                inputMode="numeric"
                placeholder={effective ? String(effective.limit) : "unknown"}
                value={value[m.id] ?? ""}
                onChange={(e) => {
                  const next = { ...value };
                  const n = Number(e.target.value);
                  if (e.target.value === "" || !Number.isFinite(n) || n <= 0) delete next[m.id];
                  else next[m.id] = Math.round(n);
                  onChange(next);
                }}
              />
              <span className="limit-source">
                {learned ? "confirmed by Google" : effective?.source === "estimate" ? "estimate" : effective ? "yours" : ""}
              </span>
            </label>
          );
        })}
      </div>
    </details>
  );
}

export function KeyPoolEditor({
  provider,
  draft,
  value,
  onChange,
}: {
  provider: KeyedProviderId;
  draft: Settings;
  value: ProviderSettings;
  onChange: (next: ProviderSettings) => void;
}) {
  useKeyEngine();
  const chats = useChats((s) => s.chats);
  const label = PROVIDERS[provider].label;
  const models = modelsFor(provider, draft);
  const defaultModel =
    draft.defaultModel.provider === provider ? draft.defaultModel.model : (models[0]?.id ?? "");
  const [model, setModel] = useState(defaultModel);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [draftName, setDraftName] = useState("");
  const [draftKey, setDraftKey] = useState("");
  const keys = value.keys;
  const views = keyEngine.view(provider, model);
  const totals = keyEngine.totals(provider, model);
  const now = Date.now();
  const titleOf = (chatId: string) => chats.find((c) => c.id === chatId)?.title ?? "another chat";

  const setKeys = (next: ApiKey[]) => onChange({ ...value, keys: next });

  const add = () => {
    const secrets = draftKey
      .split(/[\s,]+/)
      .map((k) => k.trim())
      .filter((k) => k && !keys.some((existing) => existing.key === k));
    if (secrets.length === 0) return;
    const next = [...keys];
    secrets.forEach((secret, i) => {
      const typed = draftName.trim();
      const name = typed ? (secrets.length > 1 ? `${typed} ${i + 1}` : typed) : nextName(provider, next);
      next.push({ id: uid("key-"), name, key: secret });
    });
    setKeys(next);
    setDraftKey("");
    setDraftName("");
  };

  const toggleReveal = (id: string) =>
    setRevealed((r) => {
      const next = new Set(r);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="key-pool">
      <div className="key-pool-head">
        <h4>{label}</h4>
        <span className="muted">
          {keys.length} key{keys.length === 1 ? "" : "s"} · each chat gets its own free key · switches automatically
          at a limit
        </span>
      </div>

      {keys.length > 0 && (
        <div className="key-total">
          <label className="key-total-model">
            <span>Usage for</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <UsageMeter used={totals.limit === null ? totals.used : totals.limit - (totals.remaining ?? 0)} limit={totals.limit} label={`${label} total usage`} />
          <span className="usage-text">
            {totals.limit === null
              ? `${totals.used} requests today`
              : `${(totals.remaining ?? 0).toLocaleString()}/${totals.limit.toLocaleString()} left across ${totals.total} keys`}
            {views[0]?.resetAt && <span className="muted"> · resets {formatReset(views[0].resetAt, now)}</span>}
          </span>
        </div>
      )}

      {keys.length === 0 && <div className="key-empty muted">No keys yet.</div>}
      <ol className="key-list">
        {keys.map((key) => {
          const view = views.find((v) => v.id === key.id);
          return (
            <li key={key.id} className="key-row">
              <input
                className="key-name"
                value={key.name}
                spellCheck={false}
                onChange={(e) => setKeys(keys.map((k) => (k.id === key.id ? { ...k, name: e.target.value } : k)))}
                onBlur={(e) => {
                  if (!e.target.value.trim()) {
                    setKeys(keys.map((k) => (k.id === key.id ? { ...k, name: nextName(provider, keys.filter((o) => o.id !== key.id)) } : k)));
                  }
                }}
                aria-label="Key name"
              />
              <input
                className="key-input mono"
                type={revealed.has(key.id) ? "text" : "password"}
                value={key.key}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setKeys(keys.map((k) => (k.id === key.id ? { ...k, key: e.target.value.trim() } : k)))}
                aria-label={`${key.name} secret`}
              />
              <button className="icon-btn ghost" onClick={() => toggleReveal(key.id)} title={revealed.has(key.id) ? "Hide" : "Reveal"}>
                <Icon name={revealed.has(key.id) ? "eyeOff" : "eye"} size={14} />
              </button>
              <button
                className="icon-btn ghost"
                onClick={() => setKeys(keys.filter((k) => k.id !== key.id))}
                title={`Remove ${key.name} (${mask(key.key)})`}
              >
                <Icon name="trash" size={14} />
              </button>
              <div className="key-row-usage">
                {view ? (
                  <>
                    <span className={`key-status status-${view.status}`}>{keyStatusText(view, titleOf, now)}</span>
                    <UsageMeter used={view.used} limit={view.limit} label={`${key.name} usage`} />
                    <span className="usage-text">
                      {remainingText(view)} <SourceTag source={view.limitSource} />
                    </span>
                  </>
                ) : (
                  <span className="key-status">unsaved</span>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="key-add">
        <input
          className="key-name"
          placeholder={nextName(provider, keys)}
          value={draftName}
          spellCheck={false}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          aria-label="New key name"
        />
        <input
          className="mono"
          type="password"
          placeholder={`Paste ${label} key (several separated by spaces or new lines)`}
          value={draftKey}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setDraftKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          aria-label={`New ${label} key`}
        />
        <button className="btn" onClick={add} disabled={!draftKey.trim()}>
          <Icon name="plus" size={13} /> Add
        </button>
      </div>

      {provider === "gemini" && (
        <DailyLimits
          provider={provider}
          draft={draft}
          value={value.dailyLimits}
          onChange={(dailyLimits) => onChange({ ...value, dailyLimits })}
        />
      )}
    </div>
  );
}
