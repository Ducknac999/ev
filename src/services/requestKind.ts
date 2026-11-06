/**
 * What kind of thing the user asked for, from their own words — so E.V answers the way a person
 * would: a question gets a spoken answer, a task gets a quick nod (the notch) and the music
 * keeps playing. Words in the request override it ("…out loud", "…quietly").
 */

/** "Hey E.V, can you please …", "I want you to …", "go and …" — the polite start before the verb. */
const LEAD = /^(?:(?:hey\s+)?(?:e\.?\s?v\.?|evie|eevee)[,.!\s]+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|please\s+|(?:i\s+)?(?:want|need)\s+you\s+to\s+|go\s+(?:ahead\s+and\s+|and\s+)?|let'?s\s+|now\s+|and\s+|then\s+|also\s+)*/i;

const TASK =
  /^(?:open|close|quit|play|pause|resume|stop|skip|next|previous|repeat|shuffle|loop|add|remove|delete|put|save|send|text|message|email|reply|call|turn|switch|set|change|make|create|write|draft|move|copy|rename|download|upload|install|click|press|type|scroll|navigate|start|launch|run|mute|unmute|raise|lower|increase|decrease|like|unlike|subscribe|book|order|schedule|remind|fix|clean|sort|organi[sz]e|empty|lock|minimi[sz]e|maximi[sz]e|hide|bring|go\s+(?:to|back|forward)|search\s+for|look\s+up|find\s+and|take\s+a|full\s*screen)\b/i;

const QUESTION =
  /^(?:what|what's|whats|who|who's|whom|whose|where|where's|when|why|how|which|is|are|am|was|were|do|does|did|should|have|has|tell\s+me|explain|describe|define|summari[sz]e|give\s+me|list|compare|translate|calculate|read\s+me)\b/i;

export type RequestKind = "question" | "task" | "unclear";

export function requestKind(text: string): RequestKind {
  const raw = text.trim();
  const t = raw.replace(LEAD, "").trim();
  if (TASK.test(t)) return "task";
  if (QUESTION.test(t) || /\?\s*$/.test(raw)) return "question";
  // "Can you …" with no task verb after it is usually asking something ("can you see my screen").
  if (/^(?:can|could|would|will)\s+(?:you|i|we)\b/i.test(raw)) return "question";
  return "unclear";
}

/** Words in the request that say how to answer: out loud, or quietly in the notch. */
export function voiceOverride(text: string): "speak" | "quiet" | null {
  if (/\b(?:quietly|silently|text\s+me|just\s+(?:text|show)\s+(?:me|it)|don'?t\s+(?:say|speak)\s+(?:it|anything)|no\s+talking|in\s+the\s+notch)\b/i.test(text)) return "quiet";
  if (/\b(?:out\s+loud|aloud|say\s+it|read\s+(?:it|that|this)(?:\s+out)?(?:\s+to\s+me)?|speak\s+(?:it|the\s+answer))\b/i.test(text)) return "speak";
  return null;
}
