/**
 * Some models (DeepSeek most of all) now and then write their internal tool-call markup into
 * the answer itself — "<｜DSML｜invoke name=…>", "<parameter name="expression">2*3*4</…>" —
 * instead of making the call. That text must never be shown or said. This filter sits on the
 * streamed text: it passes normal text through, holds back anything that might be the start of
 * such markup until it can tell, and drops it (keeping it aside, so the turn can be retried).
 */

const MARKUP = /<\s*[｜|]|[｜|]\s*DSML\s*[｜|]|<\/?\s*(?:parameter|invoke|function_calls?|tool_calls?|tool_call_begin|antml:[a-z_]+)\b|<\|tool|tool▁call/i;
/** How far back a "<" can still turn out to be markup. */
const LOOKBEHIND = 48;

export class LeakFilter {
  private pending = "";
  /** The markup that was dropped (empty when the answer was clean). */
  leaked = "";

  /** Text that is safe to show now. */
  push(delta: string): string {
    if (this.leaked) {
      this.leaked += delta;
      return "";
    }
    this.pending += delta;
    const hit = MARKUP.exec(this.pending);
    if (hit) {
      const out = this.pending.slice(0, hit.index).replace(/\s+$/, "");
      this.leaked = this.pending.slice(hit.index);
      this.pending = "";
      return out;
    }
    // A "<" or "｜" near the end might be the start of markup: hold it back until we can tell.
    const cut = Math.max(this.pending.lastIndexOf("<"), this.pending.lastIndexOf("｜"));
    if (cut >= 0 && this.pending.length - cut < LOOKBEHIND) {
      const out = this.pending.slice(0, cut);
      this.pending = this.pending.slice(cut);
      return out;
    }
    const out = this.pending;
    this.pending = "";
    return out;
  }

  /** The end of the stream: whatever was held back and turned out to be plain text. */
  end(): string {
    if (this.leaked) return "";
    const out = this.pending;
    this.pending = "";
    return out;
  }

  reset(): void {
    this.pending = "";
    this.leaked = "";
  }
}

/** Never read markup out loud, whatever its source. */
export function speechSafe(text: string): string {
  const at = MARKUP.exec(text);
  return (at ? text.slice(0, at.index) : text).replace(/<\/?[a-z][^>\n]{0,120}>/gi, " ");
}
