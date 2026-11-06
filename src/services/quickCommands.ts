import { macMedia, macOpen, macSystem } from "../lib/ipc";

/**
 * Instant commands: simple Mac actions E.V does itself, with no AI call — as fast as the
 * keyboard's media keys. Only an exact, whole-sentence match counts; anything more ("pause the
 * music and tell Chris…") goes to the AI as usual.
 */

export type QuickCommand =
  | { kind: "media"; action: "play" | "pause" | "next" | "previous" }
  | { kind: "volume"; to?: number; by?: number }
  | { kind: "mute"; on: boolean }
  | { kind: "dark"; on: boolean }
  | { kind: "open"; app: string };

const FILLER = /^(?:(?:ok(?:ay)?|hey|so|um+|uh+|yo)[,\s]+)*(?:(?:can|could|would|will)\s+you\s+|please\s+|just\s+|go\s+(?:ahead\s+and\s+)?)*/i;
const TAIL = /[\s,]*(?:please|for\s+me|now|right\s+now|thanks?(?:\s+you)?)*[\s.!?]*$/i;
const MEDIA_NOUN = String.raw`(?:\s+(?:the\s+|my\s+|this\s+)?(?:music|song|track|playback|audio|video|it|spotify|youtube(?:\s+music)?))?`;

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, "a hundred": 100, "one hundred": 100,
  five: 5, fifteen: 15, "twenty five": 25, "seventy five": 75, max: 100, maximum: 100, full: 100, half: 50,
};

function percent(text: string): number | undefined {
  const digits = /(\d{1,3})\s*%?/.exec(text);
  if (digits) return Math.min(100, Number(digits[1]));
  const word = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).find((w) => new RegExp(`\\b${w}\\b`, "i").test(text));
  return word === undefined ? undefined : NUMBER_WORDS[word];
}

export function parseQuickCommand(input: string): QuickCommand | null {
  const text = input.trim().replace(FILLER, "").replace(TAIL, "").trim().toLowerCase();
  if (!text || text.length > 60 || /\b(and|then|also|after|before|tell|send|message|search|find|why|what|how|who|when)\b/.test(text)) return null;

  if (new RegExp(`^(?:pause|stop|hold)${MEDIA_NOUN}$`).test(text)) return { kind: "media", action: "pause" };
  if (new RegExp(`^(?:play|resume|unpause|continue|start)${MEDIA_NOUN}(?:\\s+again)?$`).test(text)) return { kind: "media", action: "play" };
  if (/^(?:(?:skip|next)(?:\s+(?:the\s+)?(?:song|track|one))?|play\s+(?:the\s+)?next(?:\s+(?:song|track|one))?|skip\s+(?:this|it))$/.test(text)) return { kind: "media", action: "next" };
  if (/^(?:previous|last|go\s+back|back)(?:\s+(?:song|track|one))?$|^play\s+(?:the\s+)?(?:previous|last)(?:\s+(?:song|track|one))?$/.test(text)) return { kind: "media", action: "previous" };

  if (/^(?:mute|silence)(?:\s+(?:the\s+)?(?:sound|volume|audio|mac|computer|it))?$/.test(text)) return { kind: "mute", on: true };
  if (/^unmute(?:\s+(?:the\s+)?(?:sound|volume|audio|mac|computer|it))?$/.test(text)) return { kind: "mute", on: false };
  if (/^(?:turn\s+(?:the\s+)?(?:volume|sound|it)\s+up|volume\s+up|louder|raise\s+(?:the\s+)?volume)$/.test(text)) return { kind: "volume", by: 10 };
  if (/^(?:turn\s+(?:the\s+)?(?:volume|sound|it)\s+down|volume\s+down|quieter|softer|lower\s+(?:the\s+)?volume)$/.test(text)) return { kind: "volume", by: -10 };
  const volumeTo = /^(?:set\s+(?:the\s+)?)?(?:volume|sound)\s+(?:to\s+|at\s+)?(.+)$|^(?:turn|put)\s+(?:the\s+)?(?:volume|sound)\s+(?:to|at)\s+(.+)$/.exec(text);
  if (volumeTo) {
    const to = percent(volumeTo[1] ?? volumeTo[2] ?? "");
    if (to !== undefined) return { kind: "volume", to };
  }

  if (/^(?:turn\s+on\s+dark\s+mode|dark\s+mode(?:\s+on)?|switch\s+to\s+dark\s+mode|turn\s+off\s+light\s+mode|go\s+dark)$/.test(text)) return { kind: "dark", on: true };
  if (/^(?:turn\s+off\s+dark\s+mode|turn\s+on\s+light\s+mode|light\s+mode(?:\s+on)?|dark\s+mode\s+off|switch\s+to\s+light\s+mode)$/.test(text)) {
    return { kind: "dark", on: false };
  }

  const open = /^(?:open|launch|start|bring\s+up)\s+(?:up\s+)?(?:the\s+)?(?:app\s+)?([a-z0-9][\w .&+-]{0,30}?)(?:\s+app)?$/.exec(text);
  // "Open YouTube Music in Vivaldi", "open my downloads folder": websites and places go to the AI.
  if (open && !/\b(?:music|song|it|the)$/.test(open[1]) && !/[./]/.test(open[1]) && !/\b(?:in|on|with|to|website|site|page|folder|file|tab|link)\b/.test(open[1])) {
    return { kind: "open", app: open[1].replace(/\b\w/g, (c) => c.toUpperCase()) };
  }
  return null;
}

/** Does it, and returns the short confirmation E.V says or shows. */
export async function runQuickCommand(command: QuickCommand): Promise<string> {
  switch (command.kind) {
    case "media": {
      const result = await macMedia(command.action);
      if (/already playing/.test(String(result))) return "Already playing.";
      if (/already paused/.test(String(result))) return "Already paused.";
      return { play: "Playing.", pause: "Paused.", next: "Next song.", previous: "Previous song." }[command.action];
    }
    case "mute":
      await macSystem({ muted: command.on });
      return command.on ? "Muted." : "Unmuted.";
    case "volume": {
      if (command.to !== undefined) {
        await macSystem({ volume: command.to, muted: false });
        return `Volume ${command.to}.`;
      }
      const before = await macSystem({});
      const next = Math.max(0, Math.min(100, (before.volume ?? 50) + (command.by ?? 0)));
      await macSystem({ volume: next, muted: false });
      return `Volume ${next}.`;
    }
    case "dark":
      await macSystem({ darkMode: command.on });
      return command.on ? "Dark mode on." : "Light mode on.";
    case "open":
      await macOpen(undefined, command.app);
      return `Opening ${command.app}.`;
  }
}
