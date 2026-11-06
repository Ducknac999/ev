import { speechQueue } from "../audio/speech";
import { audioPlaying, macMedia, notchMessage } from "../lib/ipc";
import { uid } from "../lib/ids";
import { useVoice } from "../store/voice";
import { panelShowing } from "./quickPanel";
import { requestKind, voiceOverride } from "./requestKind";

/**
 * How E.V answers a spoken request (Hey E.V or hold to talk), like a person would:
 * - You asked something ("what's…", "how many…"): it's said out loud. Music is paused for it and
 *   comes back after. Sound that can't be paused (a call, a game) is never talked over: notch.
 * - You told it to do something ("repeat this song"): the confirmation shows in the Vorssaint notch
 *   and the music keeps playing. With nothing playing it's simply said.
 * - "…out loud" / "tell me" in the request → spoken; "…quietly" / "just text me" → notch.
 * - Afterwards: "say that" speaks the last notch answer; "shh" / "quiet" stops talking and moves
 *   the answer to the notch.
 * - When you can't see the reply (E.V isn't in front and the panel isn't showing that chat), the
 *   text also shows in the notch — 2 s for a few words, 7 s at most — then hides by itself.
 */

/** "quiet": never spoken, only shown in the notch (hold to talk with "Speak the answer" off). */
export type AnnounceMode = "hold" | "talk" | "quiet";

/** Apps E.V can pause and resume with play/pause. */
const PAUSABLE = /spotify|music|brave|chrome|safari|arc|vivaldi|edge|firefox|opera|youtube|tidal|deezer|vlc|iina|quicktime|podcasts|tv/i;

/** "Next song.", "Paused.", "Added Seasick to Beast." — not a question, short enough to glance at. */
export function isConfirmation(text: string): boolean {
  const t = text.trim();
  return t.length <= 110 && !/\?/.test(t);
}

/** About four words a second, 2–7 s. */
export function readingSeconds(text: string): number {
  return Math.min(7, Math.max(2, text.split(/\s+/).filter(Boolean).length / 4));
}

/** The last answer, for "say that" (notch only) and "shh" (being spoken). */
let last: { text: string; label?: string; at: number; spoken: boolean } | null = null;

function speak(text: string, label?: string): void {
  last = { text, label, at: Date.now(), spoken: true };
  speechQueue.feed(uid("say-"), text, true, label);
}

/** Shows text in the notch; false when the notch isn't there (Vorssaint not running). */
async function notch(text: string): Promise<boolean> {
  const seconds = readingSeconds(text);
  const shown = await notchMessage("say", text, seconds).catch(() => false);
  if (shown) notchBusyUntil = Date.now() + seconds * 1000;
  return shown;
}

let notchBusyUntil = 0;

/** Milliseconds the notch is still showing an answer (so "Waiting for your answer…" waits its turn). */
export function notchBusyFor(): number {
  return Math.max(0, notchBusyUntil - Date.now());
}

/** Resolves once E.V has finished speaking (or after a while, whatever happens). */
async function spoken(): Promise<void> {
  const started = Date.now();
  while (!useVoice.getState().speaking && Date.now() - started < 4000) await new Promise((r) => setTimeout(r, 100));
  while (useVoice.getState().speaking && Date.now() - started < 120_000) await new Promise((r) => setTimeout(r, 150));
}

/** The reply is on screen: E.V's window is the one in front, or the panel is showing that chat. */
function onScreen(chatId?: string): boolean {
  return document.hasFocus() || (chatId ? panelShowing(chatId) : false);
}

/** Says it, pausing what's playing first and resuming after. Unpausable sound: notch instead. */
async function speakOverMusic(text: string, playing: string[], label?: string): Promise<void> {
  if (!playing.length) {
    speak(text, label);
    return;
  }
  if (!playing.every((app) => PAUSABLE.test(app))) {
    if (!(await notch(text))) speak(text, label);
    else last = { text, label, at: Date.now(), spoken: false };
    return;
  }
  const paused = await macMedia("pause").catch(() => "");
  const wePaused = paused !== "" && !/already/i.test(paused);
  speak(text, label);
  await spoken();
  if (wePaused) await macMedia(/toggled/i.test(paused) ? "playpause" : "play").catch(() => {});
}

export async function announce(text: string, mode: AnnounceMode, label?: string, request = "", chatId?: string): Promise<void> {
  const said = text.trim();
  if (!said) return;
  const override = voiceOverride(request);
  if (mode === "quiet" || override === "quiet") {
    if (!(await notch(said)) && mode !== "quiet") speak(said, label);
    else last = { text: said, label, at: Date.now(), spoken: false };
    return;
  }
  const playing = await audioPlaying().catch(() => [] as string[]);
  const kind = requestKind(request);
  const toNotch = override !== "speak" && playing.length > 0 && (kind === "task" || (kind === "unclear" && isConfirmation(said)));
  if (toNotch) {
    if (!(await notch(said))) speak(said, label);
    else last = { text: said, label, at: Date.now(), spoken: false };
    return;
  }
  // Spoken — and when the reply isn't on screen, its text shows in the notch too.
  if (!onScreen(chatId)) void notch(said);
  await speakOverMusic(said, playing, label);
}

/** "Say that", "read it", "say it out loud" — on their own, right after an answer. */
const SAY_THAT = /^\s*(?:(?:say|read)\s+(?:that|it)(?:\s+again)?(?:\s+out\s+loud)?(?:\s+to\s+me)?|out\s+loud|say\s+that\s+out\s+loud|what\s+did\s+you\s+say)\s*[.!?]*\s*$/i;

/** Handles "say that". True when it was that (nothing goes to the AI). */
export function sayLastIfAsked(text: string): boolean {
  if (!SAY_THAT.test(text) || !last || Date.now() - last.at > 10 * 60_000) return false;
  const { text: said, label } = last;
  void audioPlaying()
    .catch(() => [] as string[])
    .then((playing) => speakOverMusic(said, playing, label));
  return true;
}

/** "Shh" / "quiet" while E.V is talking: stop, and put what it was saying in the notch. */
export function hushToNotch(): void {
  const wasSpeaking = useVoice.getState().speaking;
  speechQueue.stop();
  if (wasSpeaking && last?.spoken && Date.now() - last.at < 5 * 60_000) {
    last = { ...last, spoken: false };
    void notch(last.text);
  }
}
