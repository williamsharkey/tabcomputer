/**
 * The microphone in the page, as audio-capture.node's recorder gives it:
 * signed 16-bit little-endian PCM, 16 kHz, mono (Claude Code's voice stream
 * sends it on as `encoding=linear16&sample_rate=16000&channels=1`).
 * getUserMedia, then an AudioWorklet (a ScriptProcessor where there is none)
 * hands float frames at the AudioContext's rate; they are resampled here.
 */

export const PCM_RATE = 16000;
/** Samples per chunk handed on: 64 ms, near what arecord and SoX's rec deliver */
export const CHUNK_SAMPLES = 1024;

/**
 * Float samples at `inRate` to 16-bit samples at `outRate`. Each output sample
 * is the mean of the input samples it covers (a box filter, enough for speech
 * from 44.1 or 48 kHz); below `outRate` a sample repeats.
 */
export class Pcm16Resampler {
  private readonly step: number;
  private next: number;
  private pos = 0;
  private acc = 0;
  private n = 0;
  private last = 0;

  constructor(inRate: number, outRate = PCM_RATE) {
    this.step = inRate / outRate;
    this.next = this.step;
  }

  push(input: ArrayLike<number>): Int16Array {
    const out = new Int16Array(Math.ceil((input.length + 1) / this.step) + 1);
    let k = 0;
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i];
      this.n++;
      this.pos++;
      while (this.pos >= this.next) {
        if (this.n) { this.last = this.acc / this.n; this.acc = 0; this.n = 0; }
        out[k++] = toInt16(this.last);
        this.next += this.step;
      }
    }
    return out.subarray(0, k);
  }
}

export function toInt16(x: number): number {
  const v = x > 1 ? 1 : x < -1 ? -1 : x;
  return Math.round(v < 0 ? v * 0x8000 : v * 0x7fff);
}

/** 16-bit samples into little-endian byte chunks of CHUNK_SAMPLES samples */
export class PcmChunker {
  private buf: Int16Array;
  private fill = 0;
  constructor(private emit: (bytes: Uint8Array) => void, private size = CHUNK_SAMPLES) {
    this.buf = new Int16Array(size);
  }

  push(samples: Int16Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.buf[this.fill++] = samples[i];
      if (this.fill === this.size) { this.emit(le16(this.buf, this.size)); this.fill = 0; }
    }
  }
}

function le16(s: Int16Array, n: number): Uint8Array {
  const b = new Uint8Array(n * 2);
  const dv = new DataView(b.buffer);
  for (let i = 0; i < n; i++) dv.setInt16(i * 2, s[i], true);
  return b;
}

/** The browser APIs a capture uses (tests give stand-ins) */
export interface MicDeps {
  getUserMedia(c: MediaStreamConstraints): Promise<MediaStream>;
  AudioContext: new () => AudioContext;
}

export function browserMicDeps(): MicDeps | null {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  const AC = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext;
  if (!md?.getUserMedia || !AC) return null;
  return { getUserMedia: (c) => md.getUserMedia(c), AudioContext: AC };
}

/** The worklet: frames batched to 2048 before each message (one per ~43 ms at 48 kHz) */
const WORKLET = `registerProcessor('tabcomputer-mic', class extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.fill = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.fill++] = ch[i];
      if (this.fill === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.fill = 0; }
    }
    return true;
  }
});`;

export interface Capture { stop(): void }

/**
 * Record from the microphone: `onPcm` gets each chunk, `onEnd` once if the
 * capture ends by itself (the device went away, permission was revoked).
 * Rejects as getUserMedia does: NotAllowedError when the user or the browser
 * refuses, NotFoundError with no microphone.
 */
export async function startCapture(deps: MicDeps, onPcm: (bytes: Uint8Array) => void, onEnd: (reason: string) => void): Promise<Capture> {
  const stream = await deps.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  let stopped = false;
  const ctx = new deps.AudioContext();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const t of stream.getTracks()) { try { t.stop(); } catch { /* already */ } }
    try { node?.disconnect(); } catch { /* already */ }
    void ctx.close?.().catch(() => {});
  };
  let node: AudioNode | null = null;
  try {
    await ctx.resume?.().catch(() => {});
    const resampler = new Pcm16Resampler(ctx.sampleRate);
    const chunker = new PcmChunker((b) => { if (!stopped) onPcm(b); });
    const frames = (f: Float32Array) => { if (!stopped) chunker.push(resampler.push(f)); };
    const source = ctx.createMediaStreamSource(stream);
    node = await workletNode(ctx, frames) ?? scriptNode(ctx, frames);
    source.connect(node);
    // (a node nothing pulls on isn't run: through a muted gain to the speakers)
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute);
    mute.connect(ctx.destination);
  } catch (e) {
    stop();
    throw e;
  }
  for (const t of stream.getAudioTracks()) {
    t.addEventListener?.('ended', () => { if (!stopped) { stop(); onEnd('ended'); } });
  }
  return { stop };
}

async function workletNode(ctx: AudioContext, frames: (f: Float32Array) => void): Promise<AudioNode | null> {
  if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return null;
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(ctx, 'tabcomputer-mic', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    node.port.onmessage = (e) => frames(e.data as Float32Array);
    return node;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function scriptNode(ctx: AudioContext, frames: (f: Float32Array) => void): AudioNode {
  const node = ctx.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = (e) => frames(e.inputBuffer.getChannelData(0).slice(0));
  return node;
}

/** The microphone permission as the Permissions API has it (prompt where it can't say) */
export async function micPermission(): Promise<'granted' | 'denied' | 'prompt'> {
  try {
    const st = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
    if (st && (st.state === 'granted' || st.state === 'denied' || st.state === 'prompt')) return st.state;
  } catch { /* a browser without the 'microphone' permission name */ }
  return 'prompt';
}
