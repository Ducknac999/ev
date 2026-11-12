import { createContext } from "react";
import type { MessageBlock } from "../types";

/** A reply that's paused on the user: a question or an approval is waiting for their answer. */
export const WaitingForYou = createContext(false);

export function waitsForYou(blocks: MessageBlock[] | undefined): boolean {
  return (blocks ?? []).some((b) => b.type === "tool" && b.step.status === "pending" && (Boolean(b.step.question) || b.step.needsApproval === true));
}
