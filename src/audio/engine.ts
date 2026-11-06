/**
 * Single shared AudioContext with two analysers: microphone input and synthesized speech
 * output. The orb samples both every frame.
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

  context(): AudioContext {
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
    return this.micStream !== null;
  }

  /**
   * `echo`: macOS voice processing (echo cancellation). It stops E.V hearing itself through
   * speakers, but macOS also turns all other audio down while it's on — so it's off unless asked.
   */
  async startMic(echo = false): Promise<void> {
    if (this.micStream) return;
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
    return this.rms(this.micAnalyser);
  }

  /** RMS level of speech playback, normalised to roughly 0..1. */
  outputLevel(): number {
    return this.rms(this.outAnalyser);
  }

  private rms(analyser: AnalyserNode | null): number {
    if (!analyser) return 0;
    if (this.timeBuf.length !== analyser.fftSize) this.timeBuf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(this.timeBuf);
    let sum = 0;
    for (let i = 0; i < this.timeBuf.length; i++) sum += this.timeBuf[i] * this.timeBuf[i];
    return Math.min(1, Math.sqrt(sum / this.timeBuf.length) * 4);
  }

  /** Plays encoded audio through the output analyser; resolves when playback ends or stops. */
  async play(encoded: ArrayBuffer): Promise<void> {
    const ctx = this.context();
    const buffer = await ctx.decodeAudioData(encoded.slice(0));
    this.stopPlayback();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.voiceGain!);
    this.playing = source;
    await new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start();
    });
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
    if (!this.ctx || !this.voiceGain) return;
    this.voiceGain.gain.setTargetAtTime(on ? 0.1 : 1, this.ctx.currentTime, 0.02);
  }

  stopPlayback(): void {
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
