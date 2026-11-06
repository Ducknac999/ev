import { useEffect } from "react";
import { money, refreshBalance } from "../services/spending";
import { shortCount, spentToday, todayUsage, useUsage } from "../store/usage";
import type { Settings } from "../types";

/** Settings → General: what DeepSeek costs today, the balance left, and an optional daily limit. */
export function SpendingSettings({ draft, update }: { draft: Settings; update: (fn: (d: Settings) => void) => void }) {
  useUsage((s) => s.balance?.at);
  useUsage((s) => s.today);
  useEffect(() => {
    void refreshBalance(true);
  }, []);
  const balance = useUsage.getState().balance;
  const spent = spentToday();
  const today = todayUsage();
  const cachedShare = today.input ? Math.round((today.cached / today.input) * 100) : 0;
  const limit = draft.spending.dailyLimit;
  return (
    <div className="settings-card">
      <h4>Spending (DeepSeek)</h4>
      <dl className="shortcut-list">
        <div>
          <dt>Balance left</dt>
          <dd>{balance ? money(balance.amount, balance.currency) : draft.providers.deepseek.keys.length ? "Reading…" : "Add a DeepSeek key"}</dd>
        </div>
        <div>
          <dt>Spent today</dt>
          <dd>{spent === null ? "Shows after today's first answer" : `${money(spent)}${limit ? ` of ${money(limit)}` : ""}`}</dd>
        </div>
        <div>
          <dt>Tokens today</dt>
          <dd>
            {shortCount(today.input)} in ({cachedShare}% at the cheap cached price) · {shortCount(today.output)} out · {today.requests} AI calls
          </dd>
        </div>
      </dl>
      <label className="field">
        <span>Daily limit ({balance?.currency ?? "USD"}, 0 = no limit)</span>
        <input
          type="number"
          min={0}
          step={0.1}
          value={limit}
          onChange={(e) => update((d) => void (d.spending.dailyLimit = Math.max(0, Number(e.target.value) || 0)))}
        />
      </label>
      <p className="settings-intro">
        E.V warns you at 80% of the limit. At the limit it asks before spending more (a spoken request is told in the notch instead). "Spent today" is DeepSeek's own balance, so it's exact. Each answer shows its tokens under the model name.
      </p>
    </div>
  );
}
