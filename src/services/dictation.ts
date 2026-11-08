import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { dictateConfigure, notchMessage, pasteText, polishDictation, voiceEngineWarm } from "../lib/ipc";
import { useSettings } from "../store/settings";
import { cleanTranscript } from "./transcriptCleanup";
import { toggleTalkMode } from "./voiceControl";

/**
 * Dictation into any app, like Handy but tidier: hold the dictation key (Right Option by
 * default), talk, let go. Parakeet turns it into text on the Mac while you talk (piece by piece,
 * see ptt.rs), the clean-up tidies it (fillers, stutters, your dictionary, "comma", "new line"),
 * and it's pasted where your cursor is in one go — your clipboard comes back right after. The
 * last 20 dictations are kept: "Copy last dictation" in the notch and the menu bar, and if the
 * paste had nowhere to land the notch offers it to copy. No AI service, no tokens.
 */

/** `raw`: what Parakeet heard, before the clean-up (to see where a word went if one goes missing). */
export type Dictated = { text: string; raw?: string; at: number };

const HISTORY_KEY = "ev.dictations";
const KEEP = 20;

export function dictationHistory(): Dictated[] {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(HISTORY_KEY) ?? "[]") as Dictated[];
  } catch {
    return [];
  }
}

function remember(text: string, raw: string): void {
  const list = [{ text, raw, at: Date.now() }, ...dictationHistory()].slice(0, KEEP);
  globalThis.localStorage?.setItem(HISTORY_KEY, JSON.stringify(list));
  shareHistory(list);
}

/** The notch and the menu bar show the history too. */
function shareHistory(list = dictationHistory()): void {
  void emitTo("notch", "notch-dictations", list).catch(() => {});
  void invoke("tray_dictations", { items: list.slice(0, 5).map((d) => d.text) }).catch(() => {});
}

/** Polished output that added anything ("Sure, here is…", blank lines): the plain clean-up stands. */
export function acceptPolish(clean: string, polished: string): string {
  let out = polished.trim().replace(/^(?:sure|okay|ok|certainly|here(?:'s| is)|of course)[^\n]{0,60}:\s*\n+/i, "").trim();
  out = out.replace(/^["“](.*)["”]$/s, "$1");
  const lines = (s: string) => s.split("\n").length;
  if (!out || lines(out) > lines(clean)) return clean;
  const ratio = out.length / Math.max(1, clean.length);
  return ratio > 0.45 && ratio < 1.2 ? out : clean;
}

/** Text ready to paste: cleaned, and polished on this Mac when that's on. */
export async function dictationText(raw: string): Promise<string> {
  const { dictionary, dictation } = useSettings.getState().settings.voice;
  const clean = cleanTranscript(raw, { dictionary, mode: "dictation" });
  if (!dictation.polished) return clean;
  const polished = await polishDictation(clean).catch(() => clean);
  // The model may not touch the user's own spellings.
  if (dictionary.some((w) => clean.includes(w) && !polished.includes(w))) return clean;
  return acceptPolish(clean, polished);
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
  shareHistory();
  useSettings.subscribe((state, previous) => {
    if (state.settings.voice.dictation !== previous.settings.voice.dictation) configure();
  });
  void listen<string>("dictate-text", async (event) => {
    const raw = event.payload.trim();
    if (!raw) return;
    const text = await dictationText(raw);
    if (!text) return;
    remember(text, raw);
    const { trailingSpace } = useSettings.getState().settings.voice.dictation;
    const pasted = trailingSpace && !/\s$/.test(text) ? `${text} ` : text;
    // Is there somewhere to type? (Read before pasting; some apps don't say, so it's only a hint.)
    const field = await invoke<boolean | null>("focused_text_field").catch(() => null);
    try {
      await pasteText(pasted);
      lastTyped = pasted;
      if (field === false) void emitTo("notch", "notch-dictated", { text, missed: true }).catch(() => {});
      else void notchMessage("clear", "").catch(() => {});
    } catch {
      void emitTo("notch", "notch-dictated", { text, missed: true }).catch(() => {});
    }
  }).catch(() => {});
  void listen("notch-ready", () => shareHistory()).catch(() => {});
  void listen("handsfree-toggle", () => toggleTalkMode()).catch(() => {});
}
