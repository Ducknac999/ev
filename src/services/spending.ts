import { deepseekBalance } from "../lib/ipc";
import { uid } from "../lib/ids";
import { useChats } from "../store/chats";
import { useNotice } from "../store/notice";
import { useSettings } from "../store/settings";
import { dayKey, spentToday, useUsage } from "../store/usage";
import type { ToolStep } from "../types";
import { ASK_TOOL } from "../providers/agent/workTools";
import { askUser } from "./questions";
import { announce } from "./announce";

/**
 * DeepSeek spending: the account balance after each answer (DeepSeek's own number, free to ask),
 * today's spend from it, and the optional daily limit — a warning at 80%, and at the limit E.V
 * asks before spending more.
 */

let lastRead = 0;

export async function refreshBalance(force = false): Promise<void> {
  if (!force && Date.now() - lastRead < 15_000) return;
  const key = useSettings.getState().settings.providers.deepseek.keys[0]?.key;
  if (!key) return;
  lastRead = Date.now();
  try {
    const { amount, currency } = await deepseekBalance(key);
    useUsage.getState().setBalance(amount, currency);
  } catch {
    /* offline or the key can't read the balance: the token counts still show */
  }
}

export function money(amount: number, currency = useUsage.getState().balance?.currency ?? "USD"): string {
  const sign = currency === "USD" ? "$" : currency === "CNY" ? "¥" : "";
  return sign ? `${sign}${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`;
}

/**
 * Before a DeepSeek request: true to go ahead. Over today's limit, a typed request gets a card to
 * go past it (once a day); a spoken one is told, in the notch or out loud, and doesn't run.
 */
export async function withinDailyLimit(chatId: string, replyId: string, signal: AbortSignal, byVoice: boolean): Promise<boolean> {
  const limit = useSettings.getState().settings.spending.dailyLimit;
  if (!limit) return true;
  const spent = spentToday();
  if (spent === null) return true;
  const usage = useUsage.getState();
  if (spent >= limit * 0.8 && spent < limit && usage.warnedDay !== dayKey()) {
    usage.markWarned();
    useNotice.getState().show({ message: `DeepSeek today: ${money(spent)} of your ${money(limit)} daily limit.` });
  }
  if (spent < limit || usage.pastLimitDay === dayKey()) return true;
  if (byVoice) {
    void announce(`Today's DeepSeek limit of ${money(limit)} is reached. Open E.V to go past it.`, "quiet");
    return false;
  }
  const step: ToolStep = {
    id: uid("step-"),
    name: ASK_TOOL,
    args: {},
    title: "Daily spending limit reached",
    needsApproval: false,
    status: "pending",
    question: {
      question: `You've spent ${money(spent)} on DeepSeek today — your daily limit is ${money(limit)}. Keep going today?`,
      options: [
        { label: "Go past the limit today", description: "E.V won't ask again until tomorrow" },
        { label: "Stop for today", description: "Nothing is sent" },
      ],
      multi: false,
    },
  };
  useChats.getState().addBlock(chatId, replyId, { type: "tool", step });
  const answer = await askUser(step.id, signal);
  const go = Boolean(answer?.[0]?.startsWith("Go past"));
  useChats.getState().patchStep(chatId, replyId, step.id, { status: answer ? "done" : "denied", question: { ...step.question!, answer }, result: answer ? answer.join(", ") : "Skipped" });
  if (go) usage.allowPastLimit();
  return go;
}
