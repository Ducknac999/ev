import { cleanTranscript } from "./transcriptCleanup";
import { hushToNotch, notchBusyFor, sayLastIfAsked } from "./announce";
import { audioEngine, voiceLog } from "../audio/engine";
import { speechQueue } from "../audio/speech";
import { concat, encodeWav, resample } from "../audio/wav";
import { notchMessage, sttTranscribe, vadReset, voiceEngineWarm, voiceFrame } from "../lib/ipc";
import { activeChats, useChats } from "../store/chats";
import type { Chat } from "../types";
import { useSettings } from "../store/settings";
import { useVoice } from "../store/voice";
import { sendMessage } from "./chatRunner";
import { activeVoiceApproval, hearForApproval } from "./voiceApproval";
import { findWake, isEndPhrase, isStopCommand, parseWake, soundsUnfinished } from "./wakeWord";
import { useVault } from "../store/vault";
import { useDrafts } from "../store/drafts";
import { isRunning, stopGeneration } from "./chatRunner";
import { parseQuickCommand } from "./quickCommands";
import { prepareTurbo, stopTurbo, turboEnabled, turboReply } from "./turbo";

const PREROLL_MS = 300;
const HANGOVER_MS = 650;
/** Once you've talked for a while it's a longer instruction: natural pauses mustn't split it. */
const LONG_SPEECH_MS = 3_000;
const LONG_HANGOVER_MS = 1_200;
/** More speech this soon after a request started is the rest of that request. */
const JOIN_MS = 5_000;
const MIN_SPEECH_MS = 350;
const MAX_UTTERANCE_MS = 60_000;
/**
 * While E.V talks, its own voice leaks into the mic and keeps the speech detector busy, so
 * instead of waiting for a pause E.V checks the last few seconds of sound twice a second for
 * "Hey E.V" anywhere in it.
 */
const BARGE_WINDOW_MS = 2_600;
const BARGE_CHECK_MS = 480;
/** Speech that sounds unfinished ("…go to my chat with Chris,") waits this long for the rest. */
const UNFINISHED_HOLD_MS = 1_800;

async function transcribe(samples: Float32Array, sampleRate: number): Promise<string> {
  const { sttModelPath, sttLanguage } = useSettings.getState().settings.voice;
  const wav = encodeWav(resample(samples, sampleRate));
  return (await sttTranscribe(wav, sttModelPath, sttLanguage)).trim();
}

/** How loud someone spoke, in dB: the loud end (80th percentile) of 20 ms slices, so pauses don't count. */
export function speechLevel(samples: Float32Array, rate: number): number {
  const slice = Math.max(1, Math.round(rate * 0.02));
  const levels: number[] = [];
  for (let i = 0; i + slice <= samples.length; i += slice) {
    let sum = 0;
    for (let j = i; j < i + slice; j++) sum += samples[j] * samples[j];
    levels.push(Math.sqrt(sum / slice));
  }
  if (!levels.length) return -100;
  levels.sort((a, b) => a - b);
  return 20 * Math.log10(Math.max(1e-6, levels[Math.floor(levels.length * 0.8)]));
}

/**
 * Talk mode's ears. Silero (an on-device speech detector) decides whether a frame is someone
 * talking — music, typing and fans don't count; loudness is only the fallback when the detector
 * isn't installed. Emits one utterance per stretch of speech followed by HANGOVER_MS of silence.
 */
class TalkLoop {
  private unsubscribe: (() => void) | null = null;
  private noiseFloor = 0.01;
  /** Frames are judged one at a time, in order. */
  private frames: Promise<void> = Promise.resolve();
  private silero = true;
  /** Heard text that sounded unfinished, waiting briefly for the rest of the sentence. */
  private held: { text: string; timer: ReturnType<typeof setTimeout> | null; startedAt: number; level: number } | null = null;
  /** When the current utterance began: the conversation window counts from when you start talking. */
  private startedAt = 0;
  private preroll: Float32Array[] = [];
  private utterance: Float32Array[] = [];
  private speechMs = 0;
  private silenceMs = 0;
  private capturing = false;
  /** The utterance began with "Hey E.V" said over E.V's answer: keep only what follows it. */
  private afterWake = false;
  /** Listening over E.V's own voice: the last few seconds of sound. */
  private ring: Float32Array[] = [];
  private ringMs = 0;
  private sinceCheck = 0;
  private quietMs = 0;
  private checking = false;
  private ducked = false;
  private lastLoud = 0;
  /** How long a voice has been clearly over E.V's (on speakers), before turning E.V down. */
  private loudMs = 0;
  /** E.V's voice is going to speakers: only then can the mic hear it, and only then does it turn down. */
  private onSpeakers = false;
  private outputChecked = false;

  get active(): boolean {
    return this.unsubscribe !== null;
  }

  async start(): Promise<void> {
    if (this.unsubscribe) return;
    await audioEngine.startMic(useSettings.getState().settings.voice.echoCancellation);
    this.reset();
    this.silero = true;
    void vadReset().catch(() => {});
    void voiceEngineWarm().catch(() => {});
    useVoice.getState().setListen("listening");
    this.unsubscribe = audioEngine.onFrames((frame, rate, playing) => {
      this.frames = this.frames.then(() => this.onFrame(frame, rate, playing)).catch(() => {});
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.held?.timer) clearTimeout(this.held.timer);
    this.held = null;
    this.reset();
    useVoice.getState().setListen("off");
  }

  private reset(): void {
    this.preroll = [];
    this.utterance = [];
    this.speechMs = 0;
    this.silenceMs = 0;
    this.capturing = false;
    this.afterWake = false;
  }

  /** Utterances are transcribed one after another, while listening carries on. */
  private queue: Promise<void> = Promise.resolve();

  private suspended(): boolean {
    return useVoice.getState().dictatingChatId !== null;
  }

  /** Interrupting by voice needs the wake phrase; without it, only the orb interrupts. */
  private canBargeIn(): boolean {
    return useSettings.getState().settings.voice.wakeWord;
  }

  /**
   * The on-device engine removes E.V's own voice from the mic (echo cancellation against what
   * it's playing) and says whether someone is speaking. Without it: the raw mic and loudness.
   */
  private async clean(raw: Float32Array, rawRate: number, playing: Float32Array | null): Promise<{ frame: Float32Array; speech: boolean | null }> {
    const mic = resample(raw, rawRate);
    if (this.silero) {
      try {
        const out = await voiceFrame(mic, playing ? resample(playing, rawRate) : new Float32Array(mic.length));
        return { frame: out.clean, speech: out.speech };
      } catch {
        this.silero = false;
      }
    }
    return { frame: mic, speech: null };
  }

  private async onFrame(raw: Float32Array, rawRate: number, playing: Float32Array | null): Promise<void> {
    if (!this.unsubscribe) return;
    // From here on: 16 kHz, with E.V's own voice removed when the engine is installed.
    const { frame, speech } = await this.clean(raw, rawRate, playing);
    const rate = 16_000;
    if (!this.unsubscribe) return;
    const speaking = useVoice.getState().speaking;
    if (this.suspended() || (speaking && !this.canBargeIn())) {
      if (this.capturing) this.reset();
      return;
    }
    const frameMs = (frame.length / rate) * 1000;
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    // Without echo cancellation E.V's voice leaks into the mic: you need to be clearly louder than it.
    const threshold = speaking
      ? Math.max(0.02, this.noiseFloor * 4, speech === null ? audioEngine.outputLevel() * 0.12 : 0)
      : Math.max(0.012, this.noiseFloor * 3);
    const voiced = speech === null ? rms > threshold : speech && rms > 0.004;
    if (speaking) {
      if (this.capturing) this.reset();
      this.listenOver(frame, rate, frameMs, rms, threshold, voiced);
      return;
    }
    if (this.ring.length) this.clearRing();

    if (!this.capturing) {
      if (!voiced && !speaking) this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
      this.preroll.push(frame);
      let prerollMs = this.preroll.reduce((ms, f) => ms + (f.length / rate) * 1000, 0);
      while (prerollMs > PREROLL_MS && this.preroll.length > 1) {
        prerollMs -= (this.preroll.shift()!.length / rate) * 1000;
      }
      if (voiced) {
        this.capturing = true;
        this.startedAt = Date.now() - prerollMs;
        // More speech: the held words wait for it instead of timing out.
        if (this.held?.timer) {
          clearTimeout(this.held.timer);
          this.held.timer = null;
        }
        this.utterance = [...this.preroll];
        this.preroll = [];
        this.speechMs = frameMs;
        this.silenceMs = 0;
        useVoice.getState().setListen("capturing");
      }
      return;
    }

    this.utterance.push(frame);
    if (voiced) {
      this.speechMs += frameMs;
      this.silenceMs = 0;
    } else {
      this.silenceMs += frameMs;
    }
    const totalMs = this.speechMs + this.silenceMs;
    const hangover = this.speechMs >= LONG_SPEECH_MS ? LONG_HANGOVER_MS : HANGOVER_MS;
    if (this.silenceMs >= hangover || totalMs >= MAX_UTTERANCE_MS) {
      const samples = concat(this.utterance);
      const longEnough = this.speechMs >= MIN_SPEECH_MS;
      const startedAt = this.startedAt;
      const afterWake = this.afterWake;
      this.reset();
      if (longEnough) this.queue = this.queue.then(() => this.finish(samples, rate, startedAt, afterWake));
      else {
        this.armHold();
        useVoice.getState().setListen("listening");
      }
    }
  }

  private clearRing(): void {
    this.ring = [];
    this.ringMs = 0;
    this.sinceCheck = 0;
    this.loudMs = 0;
    this.outputChecked = false;
    if (this.ducked) {
      this.ducked = false;
      audioEngine.duck(false);
      voiceLog({ event: "voice-up", why: "E.V finished speaking" });
    }
  }

  /** E.V is talking: listen for "Hey E.V" over it. */
  private listenOver(frame: Float32Array, rate: number, frameMs: number, rms: number, threshold: number, speech: boolean): void {
    if (!this.outputChecked) {
      // Once per answer: headphones or speakers (the output can change between answers).
      this.outputChecked = true;
      void audioEngine.outputIsSpeakers().then((speakers) => (this.onSpeakers = speakers));
    }
    this.ring.push(frame);
    this.ringMs += frameMs;
    while (this.ringMs > BARGE_WINDOW_MS && this.ring.length > 1) this.ringMs -= (this.ring.shift()!.length / rate) * 1000;
    if (speech) {
      this.sinceCheck += frameMs;
      this.quietMs = 0;
    } else if (this.sinceCheck > 0) {
      // The user just stopped: check what they said straight away instead of waiting.
      this.quietMs += frameMs;
      if (this.quietMs >= 200) this.sinceCheck = BARGE_CHECK_MS;
    }
    // E.V keeps talking at full volume whatever it hears; only "Hey E.V" stops it (interruptCheck).
    // On speakers its own voice reaches the mic, so a voice clearly over it for a quarter second
    // turns it down a little (a short fade) to hear you better. With headphones it never does.
    const echo = audioEngine.outputLevel() * 0.25;
    const loud = this.onSpeakers && speech && rms > Math.max(threshold, echo);
    if (loud) {
      this.loudMs += frameMs;
      this.lastLoud = Date.now();
      if (!this.ducked && this.loudMs >= 250) {
        this.ducked = true;
        audioEngine.duck(true);
        voiceLog({ event: "voice-down", why: "a voice over E.V on speakers", mic: Number(rms.toFixed(4)), bar: Number(Math.max(threshold, echo).toFixed(4)) });
      }
    } else {
      this.loudMs = 0;
      if (this.ducked && !this.checking && Date.now() - this.lastLoud > 900) {
        this.ducked = false;
        audioEngine.duck(false);
        voiceLog({ event: "voice-up", why: "quiet again" });
      }
    }
    if (this.sinceCheck >= BARGE_CHECK_MS && !this.checking) {
      this.sinceCheck = 0;
      this.checking = true;
      const samples = concat(this.ring);
      const ringMs = this.ringMs;
      void this.interruptCheck(samples, rate, ringMs).finally(() => (this.checking = false));
    }
  }

  /** The last seconds while E.V talked: interrupt only if they hold "Hey E.V". */
  private async interruptCheck(samples: Float32Array, rate: number, ringMs: number): Promise<void> {
    let text = "";
    try {
      text = await transcribe(samples, rate);
    } catch {
      return; // A failed check just means no interruption.
    }
    const wake = findWake(text);
    if (!wake || !useVoice.getState().speaking) return;
    voiceLog({ event: "interrupted", why: "heard Hey E.V while speaking", heard: text.slice(0, 80) });
    const ring = this.ring;
    this.clearRing();
    if (!wake.rest || isStopCommand(wake.rest) || isEndPhrase(wake.rest)) {
      await conversation.interrupt(wake.rest);
      if (this.active) useVoice.getState().setListen("listening");
      return;
    }
    // "Hey E.V, what's…" — stop talking and keep listening: the request is still being said.
    await conversation.interrupt("");
    this.capturing = true;
    this.afterWake = true;
    this.startedAt = Date.now() - ringMs;
    this.utterance = [...ring];
    this.speechMs = ringMs;
    this.silenceMs = 0;
    useVoice.getState().setListen("capturing");
  }

  /** Sends the held words on if nothing more is said in time. */
  private armHold(): void {
    if (!this.held || this.held.timer) return;
    this.held.timer = setTimeout(() => {
      const { text, startedAt, level } = this.held ?? { text: "", startedAt: Date.now(), level: -100 };
      this.held = null;
      this.route(text, startedAt, level);
    }, UNFINISHED_HOLD_MS);
  }

  private async finish(samples: Float32Array, rate: number, spokenAt: number, afterWake = false): Promise<void> {
    const voice = useVoice.getState();
    voice.setListen("transcribing");
    try {
      let heard = await transcribe(samples, rate);
      // Said over E.V's answer: drop E.V's own words and the wake phrase.
      if (afterWake) heard = findWake(heard)?.rest ?? heard;
      // While a card waits, speech answers it and never reaches the AI (it may hold the passphrase).
      if (heard && activeVoiceApproval()) {
        await hearForApproval(heard);
        return;
      }
      // Tidied on the Mac before anything sees it: no "um", stutters or misheard names (transcriptCleanup.ts).
      if (heard) heard = cleanTranscript(heard, { dictionary: useSettings.getState().settings.voice.dictionary });
      const text = [this.held?.text, heard].filter(Boolean).join(" ");
      const startedAt = this.held?.startedAt ?? spokenAt;
      const level = Math.max(this.held?.level ?? -100, speechLevel(samples, rate));
      if (this.held?.timer) clearTimeout(this.held.timer);
      this.held = null;
      if (text && soundsUnfinished(text)) {
        this.held = { text, timer: null, startedAt, level };
        if (!this.capturing) this.armHold();
        return;
      }
      this.route(text, startedAt, level);
    } catch (err) {
      voice.setError(`Transcription failed: ${String(err)}`);
    } finally {
      if (this.active && !this.capturing) useVoice.getState().setListen("listening");
    }
  }

  private route(text: string, startedAt: number, level?: number): void {
    try {
      const message = text ? conversation.take(text, startedAt, level) : null;
      if (!message) return;
      // "Say that": the last notch answer, out loud — no AI call.
      if (sayLastIfAsked(message)) {
        conversation.answeredLocally();
        return;
      }
      // "Switch to DeepSeek" / "talk to Monkeys": the microphone moves to that chat.
      const target = parseSwitch(message);
      if (target) {
        switchTalkByVoice(target);
        return;
      }
      const chatId = useVoice.getState().talkChatId;
      const chat = useChats.getState().chats.find((c) => c.id === chatId);
      if (chat?.kind === "ai") conversation.deliver(chat.id, message);
    } catch (err) {
      useVoice.getState().setError(`Voice request failed: ${String(err)}`);
    }
  }
}

/** "I wasn't talking to you", "that wasn't for you", "ignore that". */
const NOT_FOR_YOU = /\b(i was ?n[o']?t talking to you|not talking to you|that was ?n[o']?t (for|to) you|ignore that|i was talking to (someone|somebody) else)\b/i;

/** E.V's last answer in that chat ends by asking you something. */
function askedYou(chatId: string): boolean {
  const messages = useChats.getState().chats.find((c) => c.id === chatId)?.messages ?? [];
  const answer = [...messages].reverse().find((m) => m.role === "assistant");
  const text = (answer?.content ?? "").trim();
  if (!text) return false;
  // The last sentence or two: a question there is one you're meant to answer.
  return /\?/.test(text.slice(-160));
}

/**
 * "Hey E.V" conversations. Speech only reaches an AI if it starts with the wake phrase, or
 * comes within the conversation window after E.V finished its last answer. Everything else is
 * dropped on the spot — never shown, saved or sent.
 */
class Conversation {
  private until = 0;
  /** End of the latest conversation window, kept after it closes: speech that started inside it still counts. */
  private windowEnd = 0;
  /** Chat whose answer we're waiting for; the window starts once it has finished speaking. */
  private waitingOn: string | null = null;
  /** The last request sent by voice, so a continuation can be joined to it. */
  private last: { chatId: string; text: string; at: number } | null = null;
  /** Requests that arrived while E.V was busy, sent when it's free. */
  private queued = new Map<string, string>();
  private ignored = { count: 0, loggedAt: 0 };
  /** How loud you said "Hey E.V" last (dB): a reply without it has to be about that loud. */
  private yourLevel: number | null = null;
  /** When a reply was dropped for being too quiet: "Hey E.V" soon after means it was you. */
  private droppedQuietAt = 0;
  /** The notch is showing "Waiting for your answer…". */
  private notchWaiting = false;

  constructor() {
    setInterval(() => this.tick(), 400);
  }

  private log(title: string, outcome: "done" | "ignored", detail = ""): void {
    useVault.getState().logActivity({ at: Date.now(), chat: "Voice", tool: "voice", title, outcome, detail });
  }

  private send(chatId: string, text: string): void {
    this.last = { chatId, text, at: Date.now() };
    this.awaitAnswer(chatId);
    this.log(text, "done", "Sent to the AI");
    void this.sendWithFiles(chatId, text);
  }

  /**
   * Files attached to the chat (📎, drag and drop, ⌘V) go with what was said, just like pressing
   * Enter — "look at this image" works in Talk mode. A file still uploading gets a few seconds.
   */
  private async sendWithFiles(chatId: string, text: string): Promise<void> {
    for (let i = 0; i < 25 && (useDrafts.getState().byChat[chatId] ?? []).some((d) => d.status === "uploading"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const attachments = useDrafts.getState().take(chatId);
    // With the speaker on, the finished answer is spoken — or, over music, a short confirmation shows
    // in the notch and a real answer pauses the music while it's said (see announce).
    // Spoken request → spoken answer (one rule: services/announce.ts).
    const voice = { speak: false, announce: "talk" } as const;
    // Turbo (optional): Gemini Live speaks chat-style answers; tasks, files and instant commands go the normal way.
    if (!attachments.length && turboEnabled() && !parseQuickCommand(text)) {
      const answered = await turboReply(chatId, text);
      if (!answered) void sendMessage(chatId, text, voice);
    } else {
      void sendMessage(chatId, text, { ...voice, attachments });
    }
  }

  /**
   * Hands a request to the chat. More speech arriving just after a request started is the rest
   * of it (joined and restarted); later speech while E.V is busy waits its turn — never dropped.
   */
  deliver(chatId: string, text: string): void {
    if (!isRunning(chatId)) {
      this.send(chatId, text);
      return;
    }
    const last = this.last;
    if (last && last.chatId === chatId && Date.now() - last.at < JOIN_MS) {
      const joined = `${last.text} ${text}`;
      this.last = { chatId, text: joined, at: Date.now() };
      stopGeneration(chatId);
      void (async () => {
        for (let i = 0; i < 40 && isRunning(chatId); i++) await new Promise((r) => setTimeout(r, 100));
        // Remove the half-heard request and its stopped reply; the joined one replaces them.
        const messages = useChats.getState().chats.find((c) => c.id === chatId)?.messages ?? [];
        const start = messages.map((m) => m.role === "user" && m.content === last.text).lastIndexOf(true);
        if (start >= 0) useChats.getState().dropMessages(chatId, messages.slice(start).map((m) => m.id));
        this.log(joined, "done", "Joined with what you said just before");
        this.send(chatId, joined);
      })();
      return;
    }
    this.queued.set(chatId, [this.queued.get(chatId), text].filter(Boolean).join(" "));
    this.log(text, "done", "E.V was busy — will send when it's free");
  }

  private windowMs(): number {
    return Math.min(15, Math.max(2, useSettings.getState().settings.voice.conversationSeconds)) * 1000;
  }

  private setEngaged(on: boolean): void {
    if (useVoice.getState().engaged !== on) useVoice.getState().setEngaged(on);
  }

  private tick(): void {
    for (const [chatId, text] of this.queued) {
      if (!isRunning(chatId)) {
        this.queued.delete(chatId);
        this.send(chatId, text);
      }
    }
    if (this.waitingOn) {
      const done = !isRunning(this.waitingOn) && !useVoice.getState().speaking;
      if (done) {
        const chatId = this.waitingOn;
        this.waitingOn = null;
        // Like a person: E.V only expects you to keep talking to it when it asked you something.
        const followUps = useSettings.getState().settings.voice.followUps;
        if (followUps === "always" || (followUps === "asked" && askedYou(chatId))) {
          this.openWindow();
          this.showWaiting();
        } else this.end();
      }
      return;
    }
    if (this.until && Date.now() > this.until) {
      this.until = 0;
      this.setEngaged(false);
      this.hideWaiting();
    }
  }

  private waitingTimer: ReturnType<typeof setTimeout> | null = null;

  /** "Waiting for your answer…" in the notch — after any answer still showing there has had its time. */
  private showWaiting(): void {
    if (this.waitingTimer) clearTimeout(this.waitingTimer);
    const delay = notchBusyFor();
    this.waitingTimer = setTimeout(() => {
      this.waitingTimer = null;
      const left = this.until - Date.now();
      if (left < 600) return;
      this.notchWaiting = true;
      void notchMessage("waiting", "", left / 1000).catch(() => false);
    }, delay);
  }

  private hideWaiting(): void {
    if (this.waitingTimer) {
      clearTimeout(this.waitingTimer);
      this.waitingTimer = null;
    }
    if (!this.notchWaiting) return;
    this.notchWaiting = false;
    void notchMessage("clear", "").catch(() => false);
  }

  /** Learns how far quieter than you a reply may be, from your corrections. */
  private adjustGate(by: number): void {
    const { settings, save } = useSettings.getState();
    const next = Math.min(20, Math.max(4, settings.voice.replyGateDb + by));
    if (next !== settings.voice.replyGateDb) void save({ ...settings, voice: { ...settings.voice, replyGateDb: next } });
  }

  private openWindow(): void {
    this.until = Date.now() + this.windowMs();
    this.windowEnd = this.until;
  }

  /** Open at `at` — when the user started talking, not when E.V finished understanding them. */
  private open(at = Date.now()): boolean {
    return this.waitingOn !== null || at < Math.max(this.until, this.windowEnd);
  }

  end(): void {
    this.until = 0;
    this.windowEnd = 0;
    this.waitingOn = null;
    this.setEngaged(false);
    this.hideWaiting();
  }

  /** "Hey E.V" while E.V is talking: stop the answer, then take the new request (if any). */
  async interrupt(rest: string): Promise<void> {
    if (isStopCommand(rest)) hushToNotch();
    else speechQueue.stop();
    stopTurbo();
    const chatId = useVoice.getState().talkChatId;
    if (chatId && isRunning(chatId)) stopGeneration(chatId);
    this.waitingOn = null;
    if (!rest || isStopCommand(rest) || isEndPhrase(rest)) {
      if (isEndPhrase(rest)) this.end();
      else {
        this.openWindow();
        this.setEngaged(true);
      }
      return;
    }
    const chat = useChats.getState().chats.find((c) => c.id === chatId);
    if (!chat) return;
    // Let the stopped answer finish closing before sending the new request.
    for (let i = 0; i < 30 && isRunning(chat.id); i++) await new Promise((r) => setTimeout(r, 100));
    const target = parseSwitch(rest);
    if (target) switchTalkByVoice(target);
    else if (chat.kind === "ai") this.send(chat.id, rest);
  }

  /** Handled without the AI ("say that"): the conversation stays open for the next request. */
  answeredLocally(): void {
    this.openWindow();
    this.setEngaged(true);
    this.showWaiting();
  }

  awaitAnswer(chatId: string): void {
    this.waitingOn = chatId;
    this.setEngaged(true);
  }

  /** The words to act on, or null when the speech wasn't meant for E.V. */
  take(text: string, startedAt = Date.now(), level?: number): string | null {
    if (!useSettings.getState().settings.voice.wakeWord) return text;
    const heard = parseWake(text);
    if (heard.wake) {
      prepareTurbo();
      this.hideWaiting();
      if (level !== undefined) this.yourLevel = level;
      // A reply was just dropped as background, and now you're saying it again with "Hey E.V":
      // that was you, so quieter replies count from now on.
      if (this.droppedQuietAt && Date.now() - this.droppedQuietAt < 20_000) this.adjustGate(+3);
      this.droppedQuietAt = 0;
      if (NOT_FOR_YOU.test(heard.rest)) {
        this.notForYou();
        return null;
      }
      if (isStopCommand(heard.rest)) {
        hushToNotch();
        stopTurbo();
        const chatId = useVoice.getState().talkChatId;
        if (chatId) stopGeneration(chatId);
        this.end();
        return null;
      }
      if (!heard.rest) {
        // "Hey E.V" on its own: listen for the question.
        this.openWindow();
        this.setEngaged(true);
        return null;
      }
      this.setEngaged(true);
      return heard.rest;
    }
    if (!this.open(startedAt)) {
      // Not for E.V: never stored. The log only notes, at most once a minute, that speech was ignored.
      this.ignored.count++;
      if (Date.now() - this.ignored.loggedAt > 60_000) {
        this.log(`Ignored ${this.ignored.count === 1 ? "speech" : `${this.ignored.count} bits of speech`} without “Hey E.V”`, "ignored");
        this.ignored = { count: 0, loggedAt: Date.now() };
      }
      return null;
    }
    if (isEndPhrase(heard.text)) {
      this.end();
      return null;
    }
    if (NOT_FOR_YOU.test(heard.text)) {
      this.notForYou();
      return null;
    }
    // A reply has to sound like you, not a TV or someone across the room.
    const gate = useSettings.getState().settings.voice.replyGateDb;
    if (level !== undefined && this.yourLevel !== null && level < this.yourLevel - gate) {
      this.droppedQuietAt = Date.now();
      this.log("Ignored quieter speech during a reply window (sounded like background)", "ignored");
      return null;
    }
    this.hideWaiting();
    return heard.text;
  }

  /** "I wasn't talking to you": drop what was just sent from background speech, and be stricter. */
  private notForYou(): void {
    const last = this.last;
    if (last && Date.now() - last.at < 30_000 && isRunning(last.chatId)) stopGeneration(last.chatId);
    this.adjustGate(-3);
    this.log("You said that wasn't for E.V — stopped it and will ignore quieter voices more", "done");
    this.end();
  }
}

export const conversation = new Conversation();

const talkLoop = new TalkLoop();

/** AI chats can take the microphone; Claude terminals keep their own dictation button. */
export function canTalk(chat: Chat | undefined): boolean {
  return Boolean(chat && chat.kind === "ai" && !chat.archived);
}

/**
 * Gives the microphone to one chat (only one ever has it). Talk turns that chat's speaker on;
 * the chat that had Talk before goes back to Text. The UI asks before taking it from another chat.
 */
export async function enterTalkMode(chatId?: string): Promise<void> {
  const voice = useVoice.getState();
  const { chats, focusedChatId } = useChats.getState();
  const id = chatId ?? voice.talkChatId ?? focusedChatId;
  if (!canTalk(chats.find((c) => c.id === id)) || !id) {
    voice.setError("Talk mode works in AI chats — open one and press Talk there.");
    return;
  }
  if (voice.talkChatId && voice.talkChatId !== id) {
    speechQueue.stop();
    conversation.end();
  }
  voice.setTalkChat(id);
  voice.setError(null);
  if (talkLoop.active) return;
  speechQueue.prewarm(["Paused.", "Playing.", "Next song.", "Previous song.", "Muted.", "Unmuted.", "Approved.", "Skipped.", "Already playing.", "Already paused."]);
  try {
    await talkLoop.start();
  } catch (err) {
    voice.setError(`Microphone unavailable: ${String(err)}`);
    voice.setTalkChat(null);
    talkLoop.stop();
    releaseMicIfIdle();
  }
}

export function exitTalkMode(): void {
  talkLoop.stop();
  stopTurbo();
  audioEngine.duck(false);
  conversation.end();
  useVoice.getState().setTalkChat(null);
  speechQueue.stop();
  releaseMicIfIdle();
}

/** ⌘⇧T: Talk off if it's on anywhere; otherwise Talk in the chat you're in. */
export function toggleTalkMode(): void {
  if (useVoice.getState().talkChatId) exitTalkMode();
  else void enterTalkMode(useChats.getState().focusedChatId ?? undefined);
}

/** The chat a spoken name points to: its name, its number ("chat 3") or its model ("DeepSeek"). */
export function findChatByName(name: string, chats: Chat[]): Chat | null {
  const want = name.toLowerCase().replace(/^(the|my)\s+/, "").replace(/\s+chat$/, "").trim();
  if (!want) return null;
  const ai = chats.filter(canTalk);
  const number = /^(?:chat|number)?\s*(\d+)$/.exec(want)?.[1];
  if (number) return ai.find((c) => c.seq === Number(number)) ?? null;
  const title = (c: Chat) => c.title.toLowerCase();
  return (
    ai.find((c) => title(c) === want) ??
    ai.find((c) => title(c).includes(want) || want.includes(title(c))) ??
    ai.find((c) => `${c.model.provider} ${c.model.model}`.toLowerCase().includes(want.replace(/\s+/g, ""))) ??
    ai.find((c) => want.split(/\s+/).every((w) => title(c).includes(w))) ??
    null
  );
}

/** "switch to DeepSeek", "talk to the monkeys chat" → "DeepSeek", "the monkeys chat". */
export function parseSwitch(text: string): string | null {
  return /^(?:switch|talk|change|go)\s+(?:over\s+|back\s+)?to\s+(.+?)[.!?]*$/i.exec(text.trim())?.[1] ?? null;
}

function switchTalkByVoice(name: string): void {
  const chat = findChatByName(name, activeChats(useChats.getState().chats));
  if (!chat) {
    speechQueue.feed(`switch-${Date.now()}`, `I couldn't find a chat called ${name}.`, true);
    return;
  }
  void enterTalkMode(chat.id).then(() => {
    useChats.getState().focusChat(chat.id);
    speechQueue.feed(`switch-${Date.now()}`, `Now talking to ${chat.title}.`, true);
  });
}

// Closing (or deleting) the chat that has the microphone turns Talk off.
useChats.subscribe((state) => {
  const id = useVoice.getState().talkChatId;
  if (id && !canTalk(state.chats.find((c) => c.id === id))) exitTalkMode();
});

function releaseMicIfIdle(): void {
  if (!talkLoop.active && useVoice.getState().dictatingChatId === null) audioEngine.stopMic();
}

/** Composer push-to-dictate: records until stopped, then returns the transcript. */
class Dictation {
  private frames: Float32Array[] = [];
  private rate = 48_000;
  private unsubscribe: (() => void) | null = null;

  async start(chatId: string): Promise<void> {
    if (this.unsubscribe) return;
    await audioEngine.startMic(useSettings.getState().settings.voice.echoCancellation);
    this.frames = [];
    this.unsubscribe = audioEngine.onFrames((frame, rate) => {
      this.rate = rate;
      this.frames.push(frame);
    });
    useVoice.getState().setDictating(chatId);
  }

  async stop(): Promise<string> {
    if (!this.unsubscribe) return "";
    this.unsubscribe();
    this.unsubscribe = null;
    const samples = concat(this.frames);
    this.frames = [];
    useVoice.getState().setDictating(null);
    releaseMicIfIdle();
    if (samples.length < this.rate * 0.3) return "";
    const { dictionary } = useSettings.getState().settings.voice;
    return cleanTranscript(await transcribe(samples, this.rate), { dictionary, mode: "dictation" });
  }

  cancel(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.frames = [];
    useVoice.getState().setDictating(null);
    releaseMicIfIdle();
  }
}

export const dictation = new Dictation();


export function stopSpeaking(): void {
  speechQueue.stop();
}
