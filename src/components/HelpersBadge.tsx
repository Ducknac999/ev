import type { Chat, ToolStep } from "../types";

/** The helpers step of the reply being written now, if it split the work. */
function liveHelpers(chat: Chat): ToolStep | null {
  if (chat.status !== "streaming") return null;
  const last = chat.messages.at(-1);
  for (const block of [...(last?.blocks ?? [])].reverse()) {
    if (block.type === "tool" && block.step.helpers) return block.step.status === "running" ? block.step : null;
  }
  return null;
}

export const aiCount = (helpers: number) => `${helpers + 1} AIs · main + ${helpers} helper${helpers === 1 ? "" : "s"}`;

/** In the chat header while helpers work: how many AIs are on it right now (4 at most). */
export function HelpersBadge({ chat }: { chat: Chat }) {
  const step = liveHelpers(chat);
  if (!step?.helpers) return null;
  const working = step.helpers.filter((h) => h.status === "working").length;
  return (
    <span className="helpers-badge" title={`${aiCount(step.helpers.length)} working on this — ${working} still busy`}>
      <span className="ai-dots" aria-hidden="true">
        <i className="ai-dot main" />
        {step.helpers.map((h, i) => (
          <i key={i} className={`ai-dot helper-${h.status}`} />
        ))}
      </span>
      {aiCount(step.helpers.length)}
    </span>
  );
}
