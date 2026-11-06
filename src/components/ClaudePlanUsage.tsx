import { useEffect } from "react";
import type { UsageWindow } from "../lib/ipc";
import { formatReset } from "../lib/usageFormat";
import { useNow } from "../lib/useNow";
import { refreshClaudeUsage } from "../services/usageMonitor";
import { useClaudeUsage } from "../store/claudeUsage";
import { Icon } from "./Icon";
import { UsageMeter } from "./Usage";

function PlanWindow({ title, window: w, now }: { title: string; window: UsageWindow | null; now: number }) {
  if (!w) {
    return (
      <div className="plan-window">
        <span className="plan-title">{title}</span>
        <span className="usage-text muted">Not reported for this plan</span>
      </div>
    );
  }
  const used = Math.round(w.utilization);
  return (
    <div className="plan-window">
      <span className="plan-title">{title}</span>
      <UsageMeter used={used} limit={100} label={`${title} usage`} />
      <span className="usage-text">
        {used}% used · {100 - used}% left
        {w.resetsAt && <span className="muted"> · resets {formatReset(Date.parse(w.resetsAt), now)}</span>}
      </span>
    </div>
  );
}

/** The Claude plan's 5-hour and weekly limits, as `/usage` shows them in the CLI. */
export function ClaudePlanUsage() {
  const usage = useClaudeUsage((s) => s.usage);
  const error = useClaudeUsage((s) => s.error);
  const loading = useClaudeUsage((s) => s.loading);
  const fetchedAt = useClaudeUsage((s) => s.fetchedAt);
  const now = useNow(5_000);

  useEffect(() => {
    void refreshClaudeUsage();
  }, []);

  return (
    <div className="plan-usage">
      <div className="plan-head">
        <h4>Plan usage</h4>
        <span className="muted">
          {fetchedAt ? `updated ${formatAgo(now - fetchedAt)}` : loading ? "loading…" : ""}
        </span>
        <button className="icon-btn ghost" onClick={() => void refreshClaudeUsage()} title="Refresh now" disabled={loading}>
          <Icon name="refresh" size={13} />
        </button>
      </div>
      {error && !usage && <div className="status-line bad"><Icon name="alert" size={14} /> {error}</div>}
      {usage && (
        <>
          <PlanWindow title="5-hour limit" window={usage.fiveHour} now={now} />
          <PlanWindow title="Weekly limit" window={usage.sevenDay} now={now} />
        </>
      )}
    </div>
  );
}

function formatAgo(ms: number): string {
  if (ms < 10_000) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  return `${Math.round(ms / 60_000)}m ago`;
}
