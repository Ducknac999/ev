import { modelLabel } from "../providers/catalog";
import { keyEngine } from "../providers/keyPool";
import { useClaudeUsage, windowReset } from "../store/claudeUsage";
import { useNotice } from "../store/notice";

const CLAUDE_POLL_MS = 60_000;
const KEY_TICK_MS = 15_000;

let started = false;

/** Refreshes Claude plan usage after a Claude reply, announcing any window that reset. */
export async function refreshClaudeUsage(): Promise<void> {
  const before = useClaudeUsage.getState().usage;
  const after = await useClaudeUsage.getState().refresh();
  if (!before || !after) return;
  const now = Date.now();
  if (windowReset(before.fiveHour, after.fiveHour, now)) {
    useNotice.getState().show({ message: "Claude 5-hour limit reset — back to 100%." });
  } else if (windowReset(before.sevenDay, after.sevenDay, now)) {
    useNotice.getState().show({ message: "Claude weekly limit reset — back to 100%." });
  }
}

/** Starts the background timers behind the usage bars. Safe to call more than once. */
export function startUsageMonitor(): void {
  if (started) return;
  started = true;

  keyEngine.onRecover(({ provider, keyName, model }) => {
    useNotice.getState().show({ message: `${keyName} is back to 100% for ${modelLabel({ provider, model })}.` });
  });
  keyEngine.tick();
  window.setInterval(() => keyEngine.tick(), KEY_TICK_MS);

  void refreshClaudeUsage();
  window.setInterval(() => void refreshClaudeUsage(), CLAUDE_POLL_MS);
}
