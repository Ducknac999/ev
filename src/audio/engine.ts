import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * E.V's ears and voice. Native (src-tauri/src/native_audio.rs) by default: macOS's web engine
 * won't really start the mic or play sound until E.V's page has been clicked once, so Talk mode
 * started from another app half-worked. The web path (a shared AudioContext) stays for echo
 * cancellation (macOS voice processing), Gemini Live streaming, and as a fallback.
 */
/** `playing`: what E.V was playing at the same moment (for echo cancellation). */
type FrameListener = (samples: Float32Array, sampleRate: number, playing: Float32Array | null) => void;

class AudioEngine {
  private ctx: AudioContext | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private outAnalyser: AnalyserNode | null = null;
  /** E.V's voice goes through this, so it can be turned down instantly when the user talks over it. */
  private voiceGain: GainNode | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  /** Mic on channel 0, E.V's own voice on channel 1, so both reach the processor in step. */
  private merger: ChannelMergerNode | null = null;
  private sink: GainNode | null = null;
  private frameListeners = new Set<FrameListener>();
  private playing: AudioBufferSourceNode | null = null;
  /** Chunks of a streamed reply (Gemini Live) scheduled back to back. */
  private streamed = new Set<AudioBufferSourceNode>();
  private timeBuf = new Float32Array(2048);
  /** The Mac's output device changed (headphones, a USB DAC, AirPods): the next answer gets a fresh context. */
  private deviceChanged = false;
  private echo = false;
  private watching = false;
  /** The native mic is running (frames come from Rust). */
  private nativeMic = false;
  private nativeMicLevel = 0;
  private nativeOutLevel = 0;
  private nativePlaying = false;
  private levelTimer: number | null = null;

  context(): AudioContext {
    if (!this.watching && typeof navigator !== "undefined" && navigator.mediaDevices?.addEventListener) {
      this.watching = true;
      navigator.mediaDevices.addEventListener("devicechange", () => (this.deviceChanged = true));
    }
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
      this.outAnalyser = this.ctx.createAnalyser();
      this.outAnalyser.fftSize = 2048;
      this.outAnalyser.smoothingTimeConstant = 0.6;
      this.outAnalyser.connect(this.ctx.destination);
      this.voiceGain = this.ctx.createGain();
      this.voiceGain.connect(this.outAnalyser);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  get micActive(): boolean {
    return this.micStream !== null || this.nativeMic;
  }

  /** The native mic: 16 kHz frames, each led by E.V's own voice level at that moment. */
  private async startNativeMic(): Promise<boolean> {
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (data) => {
      if (!this.nativeMic) return;
      const all = new Float32Array(data instanceof ArrayBuffer ? data : (data as unknown as ArrayBufferLike));
      this.nativeOutLevel = all[0] ?? 0;
      const samples = all.slice(1);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      this.nativeMicLevel = Math.min(1, Math.sqrt(sum / Math.max(1, samples.length)) * 4);
      for (const listener of this.frameListeners) listener(samples, 16_000, null);
    };
    this.nativeMic = true;
    const ok = await invoke<boolean>("native_mic_start", { channel }).catch(() => false);
    if (!ok) this.nativeMic = false;
    return ok;
  }

  /**
   * `echo`: macOS voice processing (echo cancellation). It stops E.V hearing itself through
   * speakers, but macOS also turns all other audio down while it's on — so it's off unless asked.
   */
  async startMic(echo = false): Promise<void> {
    this.echo = echo;
    if (this.micStream || this.nativeMic) return;
    if (!echo && (await this.startNativeMic())) return;
    const ctx = this.context();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: echo, noiseSuppression: echo, autoGainControl: echo, channelCount: 1 },
    });
    this.micStream = stream;
    this.micSource = ctx.createMediaStreamSource(stream);
    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = 2048;
    this.micAnalyser.smoothingTimeConstant = 0.5;
    this.micSource.connect(this.micAnalyser);

    // ScriptProcessor keeps capture self-contained (AudioWorklet modules would need a
    // relaxed CSP). Its output is routed through a muted gain so it keeps pulling audio.
    this.processor = ctx.createScriptProcessor(4096, 2, 1);
    this.merger = ctx.createChannelMerger(2);
    this.micSource.connect(this.merger, 0, 0);
    this.voiceGain!.connect(this.merger, 0, 1);
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.processor.onaudioprocess = (e) => {
      const samples = new Float32Array(e.inputBuffer.getChannelData(0));
      const playing = e.inputBuffer.numberOfChannels > 1 ? new Float32Array(e.inputBuffer.getChannelData(1)) : null;
      for (const listener of this.frameListeners) listener(samples, ctx.sampleRate, playing);
    };
    this.merger.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(ctx.destination);
  }

  stopMic(): void {
    if (this.nativeMic) {
      this.nativeMic = false;
      this.nativeMicLevel = 0;
      void invoke("native_mic_stop").catch(() => {});
    }
    if (this.merger) this.voiceGain?.disconnect(this.merger);
    this.merger?.disconnect();
    this.merger = null;
    this.processor?.disconnect();
    this.sink?.disconnect();
    this.micSource?.disconnect();
    this.micAnalyser?.disconnect();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.processor = null;
    this.sink = null;
    this.micSource = null;
    this.micAnalyser = null;
    this.micStream = null;
  }

  onFrames(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  /** RMS level of the microphone, normalised to roughly 0..1. */
  micLevel(): number {
    return this.nativeMic ? this.nativeMicLevel : this.rms(this.micAnalyser);
  }

  /** RMS level of speech playback, normalised to roughly 0..1. */
  outputLevel(): number {
    return this.nativePlaying ? this.nativeOutLevel : this.rms(this.outAnalyser);
  }

  private rms(analyser: AnalyserNode | null): number {
    if (!analyser) return 0;
    if (this.timeBuf.length !== analyser.fftSize) this.timeBuf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(this.timeBuf);
    let sum = 0;
    for (let i = 0; i < this.timeBuf.length; i++) sum += this.timeBuf[i] * this.timeBuf[i];
    return Math.min(1, Math.sqrt(sum / this.timeBuf.length) * 4);
  }

  /**
   * A context that can actually make sound. macOS can leave E.V's context suspended or
   * "interrupted" (after another app takes the audio, or a media key), or tied to an output device
   * that's gone — then an answer plays into nothing. Wake it, or start a new one.
   */
  private async ready(): Promise<AudioContext> {
    const changed = this.deviceChanged;
    this.deviceChanged = false;
    if (this.ctx && changed) {
      voiceLog({ event: "rebuild", why: "output device changed" });
      await this.rebuild();
    }
    let ctx = this.context();
    if (!isRunning(ctx)) {
      await wake(ctx);
      if (!isRunning(ctx)) {
        voiceLog({ event: "rebuild", why: `context ${ctx.state}` });
        await this.rebuild();
        ctx = this.context();
        await wake(ctx);
      }
    }
    return ctx;
  }

  /** A fresh context; the mic (Talk mode, Hey E.V) is reconnected to it if it was on. */
  private async rebuild(): Promise<void> {
    const old = this.ctx;
    const hadMic = this.micStream !== null;
    if (hadMic) this.stopMic();
    this.ctx = null;
    this.outAnalyser = null;
    this.voiceGain = null;
    void old?.close().catch(() => {});
    this.context();
    if (hadMic) await this.startMic(this.echo).catch(() => {});
  }

  /** Plays E.V's voice (WAV) natively; resolves when it ends or is stopped. Web audio if that fails. */
  async play(encoded: ArrayBuffer): Promise<void> {
    this.nativePlaying = true;
    // Without the mic running, the voice level for the orb is read a few times a second.
    if (!this.nativeMic && this.levelTimer === null) {
      this.levelTimer = window.setInterval(() => {
        void invoke<[number, number]>("native_levels")
          .then(([, out]) => (this.nativeOutLevel = out))
          .catch(() => {});
      }, 80);
    }
    const started = Date.now();
    try {
      // Every answer starts at full volume (talking over E.V turns it down only while you talk).
      await invoke("native_duck", { on: false }).catch(() => {});
      await invoke("native_play", new Uint8Array(encoded));
      voiceLog({ event: "native play", seconds: Math.round((Date.now() - started) / 100) / 10 });
      return;
    } catch (err) {
      voiceLog({ event: "native play failed", error: String(err).slice(0, 160) });
    } finally {
      this.nativePlaying = false;
      this.nativeOutLevel = 0;
      if (this.levelTimer !== null) window.clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    await this.playWeb(encoded);
  }

  /** The web path (the page's AudioContext). */
  private async playWeb(encoded: ArrayBuffer): Promise<void> {
    const ctx = await this.ready();
    const buffer = await ctx.decodeAudioData(encoded.slice(0));
    this.stopPlayback();
    // Every answer starts at full volume (talking over E.V turns it down only while you talk).
    this.voiceGain!.gain.cancelScheduledValues(ctx.currentTime);
    this.voiceGain!.gain.setValueAtTime(1, ctx.currentTime);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.voiceGain!);
    this.playing = source;
    let peak = 0;
    const meter = window.setInterval(() => (peak = Math.max(peak, this.outputLevel())), 100);
    await new Promise<void>((resolve) => {
      // If the context stalls, onended never comes: don't hang the queue (and the paused music).
      const guard = window.setTimeout(resolve, buffer.duration * 1000 + 2500);
      source.onended = () => {
        window.clearTimeout(guard);
        resolve();
      };
      source.start();
    });
    window.clearInterval(meter);
    voiceLog({ state: ctx.state, seconds: Math.round(buffer.duration * 10) / 10, peak: Math.round(peak * 100) / 100, rate: ctx.sampleRate });
    if (this.playing === source) this.playing = null;
  }

  /**
   * Plays 16-bit PCM chunks (base64) as they arrive, back to back. `finish()` resolves when the
   * last scheduled chunk has played, or at once if playback was stopped.
   */
  streamPcm(rate = 24_000): { push: (base64: string) => void; finish: () => Promise<void> } {
    const ctx = this.context();
    let at = 0;
    let finished = false;
    let done: () => void = () => {};
    const ended = new Promise<void>((resolve) => (done = resolve));
    const mine = new Set<AudioBufferSourceNode>();
    const settle = () => {
      if (finished && mine.size === 0) done();
    };
    return {
      push: (base64) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const pcm = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
        if (!pcm.length) return;
        const buffer = ctx.createBuffer(1, pcm.length, rate);
        const channel = buffer.getChannelData(0);
        for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.voiceGain!);
        at = Math.max(at, ctx.currentTime + 0.03);
        source.start(at);
        at += buffer.duration;
        mine.add(source);
        this.streamed.add(source);
        source.onended = () => {
          mine.delete(source);
          this.streamed.delete(source);
          settle();
        };
      },
      finish: () => {
        finished = true;
        settle();
        return ended;
      },
    };
  }

  /** Drops E.V's voice to a whisper (or back to normal) within a few milliseconds. */
  duck(on: boolean): void {
    void invoke("native_duck", { on }).catch(() => {});
    if (!this.ctx || !this.voiceGain) return;
    this.voiceGain.gain.setTargetAtTime(on ? 0.1 : 1, this.ctx.currentTime, 0.02);
  }

  stopPlayback(): void {
    if (this.nativePlaying) void invoke("native_stop").catch(() => {});
    for (const source of this.streamed) {
      try {
        source.stop();
      } catch {
        /* not started yet or already stopped */
      }
    }
    this.streamed.clear();
    if (!this.playing) return;
    try {
      this.playing.stop();
    } catch {
      /* already stopped */
    }
    this.playing = null;
  }
}

export const audioEngine = new AudioEngine();

/** The last few answers' playback (context state, length, loudness), for diagnosing silence. */
export function voiceLog(entry: Record<string, unknown>): void {
  try {
    const store = globalThis.localStorage;
    if (!store) return;
    const log = JSON.parse(store.getItem("ev.voiceLog") ?? "[]") as unknown[];
    log.push({ at: new Date().toISOString(), ...entry });
    store.setItem("ev.voiceLog", JSON.stringify(log.slice(-40)));
  } catch {
    /* diagnostics only */
  }
}

async function wake(ctx: AudioContext): Promise<void> {
  await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 800))]);
}

/** Read fresh each time (it changes while we wait). */
function isRunning(ctx: AudioContext): boolean {
  return ctx.state === "running";
}
