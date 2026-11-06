import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { UsageWindow } from "../lib/ipc";
import { useNow } from "../lib/useNow";
import { formatReset, keyStatusText, remainingText, toneFor } from "../lib/usageFormat";
import { usePopover } from "../lib/usePopover";
import { modelLabel, PROVIDERS } from "../providers/catalog";
import { keyEngine, type KeyView, type LimitSource } from "../providers/keyPool";
import { useChats } from "../store/chats";
import { useClaudeUsage } from "../store/claudeUsage";
import type { Chat, KeyedProviderId } from "../types";
import { Icon } from "./Icon";

const PICKER_WIDTH = 320;
const PICKER_MAX_HEIGHT = 460;

let engineVersion = 0;
keyEngine.subscribe(() => void engineVersion++);

/** Re-renders on every key-engine change and once a second so countdowns stay live. */
export function useKeyEngine(): number {
  const version = useSyncExternalStore(
    (onChange) => keyEngine.subscribe(onChange),
    () => engineVersion,
  );
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return version + now;
}

export function UsageMeter({
  used,
  limit,
  label,
  compact = false,
}: {
  used: number;
  limit: number | null;
  label?: string;
  compact?: boolean;
}) {
  const fraction = limit && limit > 0 ? Math.min(1, used / limit) : limit === 0 ? 1 : 0;
  const tone = limit === null ? "unknown" : toneFor(fraction);
  return (
    <span
      className={`usage-meter tone-${tone}${compact ? " compact" : ""}`}
      role="meter"
      aria-label={label ?? "Usage"}
      aria-valuemin={0}
      aria-valuemax={limit ?? 0}
      aria-valuenow={used}
    >
      <span className="usage-fill" style={{ width: `${Math.round(fraction * 100)}%` }} />
    </span>
  );
}

const SOURCE_HINT: Record<LimitSource, string> = {
  reported: "Live numbers reported by the provider",
  learned: "Daily limit confirmed by Google",
  set: "Daily limit you entered in Settings",
  estimate: "Estimated daily limit — open Settings to enter the exact number from AI Studio",
};

export function SourceTag({ source }: { source: LimitSource | null }) {
  if (source !== "estimate") return null;
  return (
    <span className="usage-est" title={SOURCE_HINT.estimate}>
      est.
    </span>
  );
}

function titleLookup(chats: Chat[]) {
  return (chatId: string) => chats.find((c) => c.id === chatId)?.title ?? "another chat";
}

/** The key this chat would show: the one streaming now, else its pin, else the last one used. */
function displayedKey(chat: Chat, views: KeyView[]): KeyView | undefined {
  const active = keyEngine.activeKeyFor(chat.id);
  const id = active?.id ?? chat.pinnedKeyId ?? chat.lastKeyId;
  return views.find((v) => v.id === id);
}

function ClaudeWindow({ label, window: w, now }: { label: string; window: UsageWindow | null; now: number }) {
  if (!w) return null;
  const used = Math.round(w.utilization);
  const reset = w.resetsAt ? formatReset(Date.parse(w.resetsAt), now) : null;
  return (
    <span className="usage-item" title={`${label}: ${used}% used${reset ? ` · resets ${reset}` : ""}`}>
      <span className="usage-label">{label}</span>
      <UsageMeter used={used} limit={100} label={`Claude ${label} usage`} compact />
      <span className="usage-text">
        {used}%{reset && <span className="muted"> · {reset}</span>}
      </span>
    </span>
  );
}

/** Claude plan usage as one small ring (5-hour window); the week's number is in its tooltip. */
export function ClaudeUsageRing() {
  const usage = useClaudeUsage((s) => s.usage);
  const now = useNow(10_000);
  const five = usage?.fiveHour;
  if (!five) return null;
  const used = Math.round(five.utilization);
  const week = usage?.sevenDay ? Math.round(usage.sevenDay.utilization) : null;
  const reset = five.resetsAt ? formatReset(Date.parse(five.resetsAt), now) : null;
  const r = 7;
  const c = 2 * Math.PI * r;
  const tone = used >= 90 ? "var(--crimson)" : used >= 70 ? "var(--amber)" : "var(--neon)";
  return (
    <span className="usage-ring" title={`Claude: ${used}% of the 5-hour limit${reset ? ` (resets ${reset})` : ""}${week !== null ? ` · ${week}% of the week` : ""}`}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r={r} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="2.2" />
        <circle cx="9" cy="9" r={r} fill="none" stroke={tone} strokeWidth="2.2" strokeLinecap="round" strokeDasharray={`${(c * used) / 100} ${c}`} transform="rotate(-90 9 9)" />
      </svg>
      <span>{used}%</span>
    </span>
  );
}

export function ClaudeUsageRow() {
  const usage = useClaudeUsage((s) => s.usage);
  const error = useClaudeUsage((s) => s.error);
  const now = useNow(10_000);
  if (!usage) {
    return <span className="usage-text muted">{error ?? "Loading Claude usage…"}</span>;
  }
  return (
    <>
      <ClaudeWindow label="5H" window={usage.fiveHour} now={now} />
      <ClaudeWindow label="WEEK" window={usage.sevenDay} now={now} />
    </>
  );
}

function KeyPicker({ chat, provider }: { chat: Chat; provider: KeyedProviderId }) {
  useKeyEngine();
  const { open, setOpen, pos, triggerRef, menuRef } = usePopover(PICKER_WIDTH, PICKER_MAX_HEIGHT);
  const chats = useChats((s) => s.chats);
  const pinKey = useChats((s) => s.pinKey);
  const views = keyEngine.view(provider, chat.model.model);
  const now = Date.now();
  const titleOf = titleLookup(chats);
  const shown = displayedKey(chat, views);
  const pinned = views.find((v) => v.id === chat.pinnedKeyId);

  const choose = (keyId: string | undefined) => {
    setOpen(false);
    pinKey(chat.id, keyId);
  };

  return (
    <>
      <button
        ref={triggerRef}
        className={`key-chip${open ? " open" : ""}${pinned ? " pinned" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={pinned ? `Using ${pinned.name} (picked by you)` : "Key chosen automatically — click to pick one"}
      >
        <Icon name="key" size={11} />
        <span className="key-chip-label">{shown?.name ?? "Auto"}</span>
        {!pinned && shown && <span className="key-chip-auto">AUTO</span>}
        <Icon name="chevron" size={10} className="muted" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="model-menu key-menu"
            role="listbox"
            style={{ left: pos.left, top: pos.top, maxHeight: pos.maxHeight, width: PICKER_WIDTH }}
          >
            <div className="key-menu-head">
              {PROVIDERS[provider].label} keys · {modelLabel(chat.model)}
            </div>
            <button
              role="option"
              aria-selected={!chat.pinnedKeyId}
              className={`key-option${!chat.pinnedKeyId ? " selected" : ""}`}
              onClick={() => choose(undefined)}
            >
              <span className="key-option-main">
                <span className="key-option-name">Automatic</span>
                <span className="key-option-status">Picks a free key and switches when one runs out</span>
              </span>
              {!chat.pinnedKeyId && <Icon name="check" size={13} />}
            </button>
            {views.map((v) => (
              <button
                key={v.id}
                role="option"
                aria-selected={chat.pinnedKeyId === v.id}
                className={`key-option status-${v.status}${chat.pinnedKeyId === v.id ? " selected" : ""}`}
                onClick={() => choose(v.id)}
              >
                <span className="key-option-main">
                  <span className="key-option-name">{v.name}</span>
                  <span className="key-option-status">{keyStatusText(v, titleOf, now)}</span>
                  <span className="key-option-usage">
                    <UsageMeter used={v.used} limit={v.limit} label={`${v.name} usage`} compact />
                    <span className="usage-text">
                      {remainingText(v)} <SourceTag source={v.limitSource} />
                    </span>
                  </span>
                </span>
                {chat.pinnedKeyId === v.id && <Icon name="check" size={13} />}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

function KeyedUsageRow({ chat, provider }: { chat: Chat; provider: KeyedProviderId }) {
  useKeyEngine();
  const views = keyEngine.view(provider, chat.model.model);
  if (views.length === 0) {
    return <span className="usage-text warn">No {PROVIDERS[provider].label} keys — add one in Settings</span>;
  }
  const shown = displayedKey(chat, views);
  const now = Date.now();
  const totals = keyEngine.totals(provider, chat.model.model);
  const subject = shown ?? {
    used: totals.used,
    limit: totals.limit,
    remaining: totals.remaining,
    resetAt: views[0].resetAt,
    limitSource: views[0].limitSource,
  };
  const blocked = shown && (shown.status === "exhausted" || shown.status === "cooling") && shown.until;
  return (
    <>
      <KeyPicker chat={chat} provider={provider} />
      <span className="usage-item grow" title={`${totals.usable} of ${totals.total} keys usable for ${modelLabel(chat.model)}`}>
        <UsageMeter used={subject.used} limit={subject.limit} label="Key usage" />
        <span className="usage-text">
          {remainingText(subject)} <SourceTag source={subject.limitSource} />
          {blocked ? (
            <span className="muted"> · back {formatReset(shown.until!, now)}</span>
          ) : (
            subject.resetAt && <span className="muted"> · resets {formatReset(subject.resetAt, now)}</span>
          )}
        </span>
      </span>
    </>
  );
}

/** Usage strip under a chat's model picker: Claude plan windows, or the chat's API key. */
export function ChatUsageRow({ chat }: { chat: Chat }) {
  const provider = chat.model.provider;
  return (
    <div className="pane-row pane-usage">
      {provider === "claude" ? <ClaudeUsageRow /> : <KeyedUsageRow chat={chat} provider={provider} />}
    </div>
  );
}
