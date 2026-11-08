import { listen } from "@tauri-apps/api/event";
import { dictateConfigure, macType, notchMessage, polishDictation, voiceEngineWarm } from "../lib/ipc";
import { useSettings } from "../store/settings";
import { cleanTranscript } from "./transcriptCleanup";
import { toggleTalkMode } from "./voiceControl";

/**
 * Dictation into any app: hold the dictation key (Right Option by default), talk, let go. Parakeet
 * turns it into text on the Mac, the clean-up tidies it (fillers, stutters, your dictionary,
 * "comma" / "new line"), Apple's on-device model fixes self-corrections when "polished" is on,
 * and the words are typed where your cursor is — Claude Code, Cursor, Slack, Mail, anywhere.
 * No AI service, no tokens. Double-tap ⌘ turns hands-free (Talk mode) on or off.
 */

/** Text ready to type: cleaned, and polished on this Mac when that's on. */
export async function dictationText(raw: string): Promise<string> {
  const { dictionary, dictation } = useSettings.getState().settings.voice;
  const clean = cleanTranscript(raw, { dictionary, mode: "dictation" });
  if (!dictation.polished) return clean;
  const polished = await polishDictation(clean).catch(() => clean);
  // The model may not touch the user's own spellings or line breaks.
  return dictionary.some((w) => clean.includes(w) && !polished.includes(w)) || clean.includes("\n") ? clean : polished;
}

let lastTyped = "";

/** What dictation typed last ("delete that" removes it). */
export function lastDictated(): string {
  return lastTyped;
}

function configure(): void {
  const { dictation } = useSettings.getState().settings.voice;
  void dictateConfigure(dictation.enabled ? dictation.shortcut : null, dictation.doubleCommand).catch(() => {});
}

let started = false;

export function startDictation(): void {
  if (started) return;
  started = true;
  configure();
  // Parakeet loaded now, so the first thing you say isn't the slow one.
  void voiceEngineWarm().catch(() => {});
  useSettings.subscribe((state, previous) => {
    if (state.settings.voice.dictation !== previous.settings.voice.dictation) configure();
  });
  void listen<string>("dictate-text", async (event) => {
    const raw = event.payload.trim();
    if (!raw) return;
    const text = await dictationText(raw);
    try {
      // Typed into whatever has the cursor (an empty app = the focused field, wherever it is).
      await macType(text, "", true);
      lastTyped = text;
      void notchMessage("clear", "").catch(() => {});
    } catch {
      void notchMessage("say", "Couldn't type there — click into a text field and try again.", 4).catch(() => {});
    }
  }).catch(() => {});
  void listen("handsfree-toggle", () => toggleTalkMode()).catch(() => {});
}
