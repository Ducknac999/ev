import { canThink, modelLabel } from "../providers/catalog";
import type { ModelRef } from "../types";

/**
 * "switch to pro", "vision", "thinking off", "pro no thinking": changes the chat's DeepSeek model
 * and Think switch at once, with no AI call. Only short commands made of these words count, so a
 * real question that mentions "pro" or "vision" still goes to the AI.
 */
export interface ModelCommand {
  model?: ModelRef;
  thinking?: boolean;
}

const LEAD = /^(?:please\s+)?(?:switch|change|swap|go|move|set|use|turn|put)?\s*(?:it\s+|this\s+|the\s+chat\s+|chat\s+)?(?:to|into|on|onto)?\s*/;
const WORDS = new Set(["deepseek", "v4", "v41", "v4.1", "4.1", "model", "the", "pro", "flash", "vision", "with", "without", "no", "thinking", "think", "on", "off", "and", "mode", "turn", "switch", "to", "use", "please"]);

export function parseModelCommand(input: string): ModelCommand | null {
  const text = input.trim().toLowerCase().replace(/[.!,]+$/g, "").replace(/[,]/g, " ");
  if (!text || text.length > 50) return null;
  const words = text.replace(LEAD, "").split(/\s+/).filter(Boolean);
  if (!words.length || !words.every((w) => WORDS.has(w))) return null;
  const has = (w: string) => words.includes(w);
  const command: ModelCommand = {};
  if (has("vision")) command.model = { provider: "deepseek", model: "deepseek-flash-vision" };
  else if (has("pro")) command.model = { provider: "deepseek", model: "deepseek-v4-pro" };
  else if (has("flash")) command.model = { provider: "deepseek", model: "deepseek-flash" };
  if (has("thinking") || has("think")) command.thinking = !(has("off") || has("no") || has("without"));
  return command.model || command.thinking !== undefined ? command : null;
}

/** "Now: DeepSeek V4 Pro · Think off". */
export function describeModel(model: ModelRef, thinking: boolean): string {
  return `Now: ${modelLabel(model)}${canThink(model) ? ` · Think ${thinking ? "on" : "off"}` : ""}`;
}
