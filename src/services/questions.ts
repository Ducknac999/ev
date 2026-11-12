/**
 * Questions the AI asks with clickable choices (ask_user). The agent loop waits on `askUser`; the
 * card's buttons (or a typed answer) call `answerQuestion`. Stopping the task cancels the wait.
 */
const waiting = new Map<string, (answer: string[] | null) => void>();

export function askUser(id: string, signal: AbortSignal): Promise<string[] | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const onAbort = () => answerQuestion(id, null);
    signal.addEventListener("abort", onAbort, { once: true });
    waiting.set(id, (answer) => {
      signal.removeEventListener("abort", onAbort);
      resolve(answer);
    });
  });
}

/** `null` = skipped. */
export function answerQuestion(id: string, answer: string[] | null): void {
  const resolve = waiting.get(id);
  if (!resolve) return;
  waiting.delete(id);
  resolve(answer);
}

export function isAsking(id: string): boolean {
  return waiting.has(id);
}

/** How many questions are waiting for an answer right now. */
export function askingCount(): number {
  return waiting.size;
}
