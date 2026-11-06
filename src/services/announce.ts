import { speechQueue } from "../audio/speech";
import { audioPlaying, macMedia, notchMessage } from "../lib/ipc";
import { uid } from "../lib/ids";
import { useVoice } from "../store/voice";
import { panelShowing } from "./quickPanel";
import { requestKind, voiceOverride } from "./requestKind";
import { useSettings } from "../store/settings";

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

/**
 * THE rule for talking — every spoken reply in E.V goes through here, so it behaves the same in
 * every chat, the quick panel, Talk mode and hold to talk:
 * - Typed requests are answered in text (silent), unless Settings says otherwise or the request
 *   says "…out loud".
 * - Spoken requests are answered out loud. With music playing: a question pauses it and is said;
 *   a task ("skip", "repeat this") gets a quick notch line and the music keeps going.
 * - "…quietly" → notch. Mute (top bar) → nothing is spoken; everything goes to the notch.
 * When the answer isn't on screen, its text also shows in the notch (2–7 s).
 * The reason is written under the answer ("🔈 Spoken: you asked by voice").
 */
export type Why = { spoken: boolean; note: string };

export async function announce(text: string, mode: AnnounceMode, label?: string, request = "", chatId?: string): Promise<Why> {
  const said = text.trim();
  if (!said) return { spoken: false, note: "" };
  const override = voiceOverride(request);
  if (useVoice.getState().muted) {
    void notch(said);
    last = { text: said, label, at: Date.now(), spoken: false };
    return { spoken: false, note: "🔇 Not spoken: E.V is muted (top bar)" };
  }
  if (mode === "quiet" || override === "quiet") {
    if (!(await notch(said))) speak(said, label);
    else last = { text: said, label, at: Date.now(), spoken: false };
    return { spoken: false, note: "🔇 Not spoken: you asked for it quietly" };
  }
  const playing = await audioPlaying().catch(() => [] as string[]);
  const kind = requestKind(request);
  const isTask = kind === "task" || (kind === "unclear" && isConfirmation(said));
  const tasksOverMusic = useSettings.getState().settings.voice.replies.tasksOverMusic;
  if (override !== "speak" && playing.length > 0 && isTask && tasksOverMusic === "notch") {
    if (!(await notch(said))) speak(said, label);
    else last = { text: said, label, at: Date.now(), spoken: false };
    return { spoken: false, note: "🔇 Shown in the notch: a task while music plays" };
  }
  if (!onScreen(chatId)) void notch(said);
  await speakOverMusic(said, playing, label);
  return { spoken: true, note: override === "speak" ? "🔈 Spoken: you asked for it out loud" : playing.length ? "🔈 Spoken (music paused): you asked by voice" : "🔈 Spoken: you asked by voice" };
}

/** Options for a typed request: silent, unless it says "…out loud" or Settings speaks typed replies. */
export function typedReply(text: string): { announce?: AnnounceMode } {
  const always = useSettings.getState().settings.voice.replies.typed === "speak";
  return always || voiceOverride(text) === "speak" ? { announce: "talk" } : {};
}

/**
 * Something you must not miss — a reminder, an approval E.V needs, a task that failed: out loud
 * (music paused) and in the notch, however the request came in. Muted, or set to notch only:
 * the notch with a sound.
 */
export async function announceImportant(text: string): Promise<void> {
  const said = text.trim();
  if (!said) return;
  const toNotch = useVoice.getState().muted || useSettings.getState().settings.voice.replies.important === "notch";
  void notch(said);
  if (toNotch) {
    void playChime();
    return;
  }
  const playing = await audioPlaying().catch(() => [] as string[]);
  await speakOverMusic(said, playing);
}

/** A short system sound for alerts that aren't spoken. */
async function playChime(): Promise<void> {
  try {
    const ctx = new AudioContext();
    // Two soft notes, like a calendar alert.
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = ctx.currentTime + i * 0.18;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    });
    window.setTimeout(() => void ctx.close(), 1000);
  } catch {
    /* audio unavailable: the notch still shows it */
  }
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
