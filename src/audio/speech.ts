import { ttsSynthesize } from "../lib/ipc";
import { useSettings } from "../store/settings";
import { useVoice } from "../store/voice";
import { audioEngine, voiceLog } from "./engine";
import { takeSpeakable } from "./speakable";
import { speechSafe } from "../services/leakFilter";

/**
 * Serial text-to-speech queue. Streaming replies are fed incrementally and spoken sentence by
 * sentence; the next segment is synthesized while the current one plays. Replies from different
 * chats take turns — one finishes before the next starts — and each can begin with its chat's name.
 */

interface Stream {
  key: string;
  segments: string[];
  done: boolean;
  /** Last time it got more to say (a reply that stops streaming without finishing is skipped after a while). */
  touched: number;
}

/** A reply that goes quiet this long without finishing lets the next one speak. */
const STALE_MS = 20_000;

class SpeechQueue {
  private offsets = new Map<string, number>();
  private streams: Stream[] = [];
  private running = false;
  private generation = 0;
  /** The chat name said last: a reply only starts with its name when the speaking chat changes. */
  private lastLabel: string | null = null;

  /** `label`: said once before this reply starts, e.g. the chat's name. */
  feed(streamKey: string, fullText: string, done: boolean, label?: string): void {
    // Markup (a model's leaked tool call, stray tags) is never read out loud.
    fullText = speechSafe(fullText);
    const offset = this.offsets.get(streamKey) ?? 0;
    const { segment, next } = takeSpeakable(fullText, offset, done);
    if (done) this.offsets.delete(streamKey);
    else this.offsets.set(streamKey, next);
    let stream = this.streams.find((s) => s.key === streamKey);
    if (!stream && (segment || !done)) {
      const announce = Boolean(label && label !== this.lastLabel);
      if (label) this.lastLabel = label;
      stream = { key: streamKey, segments: announce ? [`${label}.`] : [], done: false, touched: Date.now() };
      this.streams.push(stream);
    }
    if (!stream) return;
    if (segment) stream.segments.push(segment);
    stream.done = stream.done || done;
    stream.touched = Date.now();
    void this.drain();
  }

  /** The next sentence to say: from the reply speaking now, which keeps the turn until it's finished. */
  private nextSegment(): string | null | "wait" {
    while (this.streams.length) {
      const head = this.streams[0];
      if (head.segments.length) return head.segments.shift()!;
      if (head.done || Date.now() - head.touched > STALE_MS) {
        this.streams.shift();
        continue;
      }
      return "wait";
    }
    return null;
  }

  /** Prepares phrases ahead of time so they play without any delay. */
  prewarm(phrases: string[]): void {
    for (const phrase of phrases) void this.synth(phrase).catch(() => {});
  }

  stop(): void {
    this.generation++;
    this.streams = [];
    this.offsets.clear();
    audioEngine.stopPlayback();
    useVoice.getState().setSpeaking(false);
  }

  /** Short phrases ("Paused.", "Next song.") are kept, so they play instantly the next time. */
  private cache = new Map<string, Promise<ArrayBuffer>>();

  private synth(text: string): Promise<ArrayBuffer> {
    const { ttsVoice, ttsRate } = useSettings.getState().settings.voice;
    if (text.length > 40) return ttsSynthesize(text, ttsVoice, ttsRate);
    const key = `${ttsVoice}|${ttsRate}|${text}`;
    let audio = this.cache.get(key);
    if (!audio) {
      audio = ttsSynthesize(text, ttsVoice, ttsRate);
      audio.catch(() => this.cache.delete(key));
      if (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, audio);
    }
    return audio;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const generation = this.generation;
    useVoice.getState().setSpeaking(true);
    try {
      let upcoming: Promise<ArrayBuffer> | null = null;
      while (generation === this.generation) {
        let current = upcoming;
        upcoming = null;
        if (!current) {
          const next = this.nextSegment();
          if (next === null) break;
          if (next === "wait") {
            // The reply speaking now is still being written: wait for its next sentence.
            await new Promise((r) => setTimeout(r, 120));
            continue;
          }
          current = this.synth(next);
        }
        let audio: ArrayBuffer;
        try {
          audio = await current;
        } catch (err) {
          useVoice.getState().setError(`Speech failed: ${String(err)}`);
          voiceLog({ event: "synth failed", error: String(err).slice(0, 200) });
          continue;
        }
        if (generation !== this.generation) break;
        const following = this.nextSegment();
        if (following !== null && following !== "wait") {
          upcoming = this.synth(following);
          upcoming.catch(() => undefined);
        }
        await audioEngine.play(audio);
      }
    } finally {
      this.running = false;
      if (generation === this.generation && this.streams.some((s) => s.segments.length)) void this.drain();
      else if (generation === this.generation) useVoice.getState().setSpeaking(false);
    }
  }
}

export const speechQueue = new SpeechQueue();
