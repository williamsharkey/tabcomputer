/**
 * claude --vm's stand-ins for native Claude Code's two addons
 * (src/claude-vm/addons/): clipboard-napi.node on the browser clipboard,
 * audio-capture.node on getUserMedia. The browser APIs are stand-ins here;
 * the calls and what is checked of their results are Claude Code 2.1.296's.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import { createBun } from '@shiro/claude-vm/bun/index';
import { addonLoader } from '@shiro/claude-vm/addons/index';
import { directBridge, guestBridge, pageCallServer, PAGE_CALL } from '@shiro/claude-vm/addons/bridge';
import { createClipboardAddon } from '@shiro/claude-vm/addons/clipboard-napi';
import { createAudioCaptureAddon } from '@shiro/claude-vm/addons/audio-capture';
import { Pcm16Resampler, PcmChunker, toInt16, startCapture, CHUNK_SAMPLES, type MicDeps } from '@shiro/claude-vm/addons/mic';
import { runPageOp, setMicDeps } from '@shiro/claude-vm/addons/page-ops';
import { resetClipboard } from '@shiro/utils/clipboard';
import { FileSystem } from '@shiro/filesystem';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** navigator.clipboard as the page has it: `refuse` makes writes and reads throw, as an unfocused tab's do */
function stubClipboard(init = '') {
  const state = { text: init, refuse: false, hang: false, writes: [] as string[] };
  vi.stubGlobal('navigator', {
    clipboard: {
      async writeText(t: string) { if (state.refuse) throw new DOMException('Document is not focused.', 'NotAllowedError'); state.writes.push(t); state.text = t; },
      readText() {
        if (state.hang) return new Promise(() => {});
        return state.refuse ? Promise.reject(new DOMException('Document is not focused.', 'NotAllowedError')) : Promise.resolve(state.text);
      },
    },
  });
  return state;
}

/**
 * A microphone and an AudioContext at `rate` without an AudioWorklet (the ScriptProcessor path):
 * `feed` hands the processor one block, `endTrack` unplugs the device.
 */
function fakeMic(rate = 48000, refuse?: string) {
  const tracks: any[] = [];
  const st = { stopped: 0, closed: false, connected: [] as string[], processor: null as any, constraints: null as any };
  const track = () => {
    const listeners: Record<string, (() => void)[]> = {};
    const t = { stop() { st.stopped++; }, addEventListener(ev: string, f: () => void) { (listeners[ev] ??= []).push(f); }, fire(ev: string) { for (const f of listeners[ev] ?? []) f(); } };
    tracks.push(t);
    return t;
  };
  class FakeContext {
    sampleRate = rate;
    destination = { name: 'destination' };
    async resume() {}
    async close() { st.closed = true; }
    createMediaStreamSource() { return { connect: (n: any) => st.connected.push(`source→${n.name}`) }; }
    createScriptProcessor() {
      const node: any = { name: 'processor', connect: (n: any) => st.connected.push(`processor→${n.name}`), disconnect() {} };
      st.processor = node;
      return node;
    }
    createGain() { return { name: 'gain', gain: { value: 1 }, connect: (n: any) => st.connected.push(`gain→${n.name}`) }; }
  }
  const deps: MicDeps = {
    async getUserMedia(c) {
      st.constraints = c;
      if (refuse) throw new DOMException('Permission denied', refuse);
      const t = track();
      return { getTracks: () => [t], getAudioTracks: () => [t] } as any;
    },
    AudioContext: FakeContext as any,
  };
  const feed = (samples: Float32Array) => st.processor.onaudioprocess({ inputBuffer: { getChannelData: () => samples } });
  return { deps, st, tracks, feed, endTrack: () => tracks.at(-1).fire('ended') };
}

const sine = (n: number, rate: number, hz = 440, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));
const samplesOf = (b: Uint8Array) => { const dv = new DataView(b.buffer, b.byteOffset, b.byteLength); return Array.from({ length: b.length / 2 }, (_, i) => dv.getInt16(i * 2, true)); };

afterEach(() => {
  vi.unstubAllGlobals();
  resetClipboard();
  setMicDeps(() => null);
});

describe('loading the addons (Bun.__require, loader napi)', () => {
  it("gives each addon's stand-in, the same object each time; another addon fails as dlopen does", () => {
    const Bun: any = createBun({ fs, process, childProcess, Buffer, assets: { '/vm/clipboard-napi.node': 10, '/vm/audio-capture.node': 10, '/vm/other.node': 10 }, page: { call: async () => 'prompt' } });
    const req = Bun.__require(Object.assign(() => { throw new Error('not an asset'); }, { resolve: () => '' }));
    const clip = req('/vm/clipboard-napi.node');
    expect(typeof clip.setLinuxClipboardText).toBe('function');
    expect(typeof clip.getLinuxClipboardText).toBe('function');
    expect(req('/vm/clipboard-napi.node')).toBe(clip);
    const audio = req('/vm/audio-capture.node');
    for (const f of ['startRecording', 'stopRecording', 'isRecording', 'startPlayback', 'writePlaybackData', 'stopPlayback', 'isPlaying', 'microphoneAuthorizationStatus']) expect(typeof audio[f]).toBe('function');
    expect(() => req('/vm/other.node')).toThrow(expect.objectContaining({ code: 'ERR_DLOPEN_FAILED' }));
    // (Claude Code's fallback paths aren't assets: the process's own require, which can't load .node files)
    expect(() => req('./vendor/clipboard-napi/x64-linux/clipboard-napi.node')).toThrow('not an asset');
  });

  it('a loader per process keeps its own instances', () => {
    const page = { call: async () => undefined };
    const a = addonLoader({ page }), b = addonLoader({ page });
    expect(a('/x/audio-capture.node')).toBe(a('/y/audio-capture.node'));
    expect(a('/x/audio-capture.node')).not.toBe(b('/x/audio-capture.node'));
  });
});

describe('clipboard-napi.node', () => {
  it('writes the browser clipboard and reads it back; empty reads are null', async () => {
    const st = stubClipboard('');
    const clip = createClipboardAddon(directBridge());
    expect(await clip.getLinuxClipboardText(false, 2000)).toBe(null);
    expect(clip.setLinuxClipboardText('héllo\n')).toBe(true);
    await tick();
    expect(st.writes).toEqual(['héllo\n']);
    expect(await clip.getLinuxClipboardText(false, 2000)).toBe('héllo\n');
    // (no PRIMARY selection in a browser: the clipboard)
    expect(await clip.getLinuxClipboardText(true, 2000)).toBe('héllo\n');
  });

  it('a write the browser refuses is kept and read back (written when the tab gets focus)', async () => {
    const st = stubClipboard('old');
    st.refuse = true;
    const clip = createClipboardAddon(directBridge());
    expect(clip.setLinuxClipboardText('kept')).toBe(true);
    await tick();
    expect(st.writes).toEqual([]);
    expect(await clip.getLinuxClipboardText(false, 2000)).toBe('kept');
  });

  it("a read that doesn't answer in time is null", async () => {
    const st = stubClipboard('x');
    st.hang = true;
    const clip = createClipboardAddon(directBridge());
    const t0 = Date.now();
    expect(await clip.getLinuxClipboardText(false, 50)).toBe(null);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('the microphone (mic.ts)', () => {
  it('toInt16 clamps and scales', () => {
    expect([toInt16(0), toInt16(1), toInt16(-1), toInt16(2), toInt16(-2), toInt16(0.5)]).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
  });

  it('resamples 48 kHz and 44.1 kHz to 16 kHz, keeping the signal', () => {
    const r48 = new Pcm16Resampler(48000);
    let n = 0;
    const out: number[] = [];
    for (let i = 0; i < 10; i++) { const o = r48.push(sine(4800, 48000).subarray(0, 4800)); n += o.length; out.push(...o); }
    expect(n).toBe(16000);
    const r44 = new Pcm16Resampler(44100);
    let m = 0;
    for (let i = 0; i < 9; i++) m += r44.push(new Float32Array(4900)).length;
    expect(Math.abs(m - 16000)).toBeLessThanOrEqual(1);
    // a 440 Hz tone at half scale stays near half scale, with its zero crossings ~880 a second
    const peak = Math.max(...out.slice(0, 1600).map(Math.abs));
    expect(peak).toBeGreaterThan(15000);
    expect(peak).toBeLessThan(16500);
    let crossings = 0;
    for (let i = 1; i < 16000; i++) if ((out[i - 1] < 0) !== (out[i] < 0)) crossings++;
    expect(Math.abs(crossings - 880)).toBeLessThan(20);
  });

  it('repeats samples below 16 kHz', () => {
    expect(Array.from(new Pcm16Resampler(8000).push([0.5, -0.5]))).toEqual([16384, 16384, -16384, -16384]);
  });

  it('chunks 16-bit samples as little-endian bytes', () => {
    const got: Uint8Array[] = [];
    const c = new PcmChunker((b) => got.push(b), 3);
    c.push(Int16Array.from([1, -1, 256, 7]));
    expect(got.length).toBe(1);
    expect(Array.from(got[0])).toEqual([1, 0, 0xff, 0xff, 0, 1]);
  });

  it('captures through getUserMedia: 16 kHz PCM chunks, the graph pulled to the speakers muted, stop releases the device', async () => {
    const mic = fakeMic(48000);
    const chunks: Uint8Array[] = [];
    const ends: string[] = [];
    const cap = await startCapture(mic.deps, (b) => chunks.push(b), (r) => ends.push(r));
    expect(mic.st.constraints).toMatchObject({ audio: { channelCount: 1, echoCancellation: true } });
    expect(mic.st.connected).toEqual(['source→processor', 'processor→gain', 'gain→destination']);
    for (let i = 0; i < 3; i++) mic.feed(sine(4096, 48000));
    // 12288 samples at 48 kHz: 4096 at 16 kHz, four whole chunks
    expect(chunks.length).toBe(4);
    expect(chunks.every((c) => c.length === CHUNK_SAMPLES * 2)).toBe(true);
    expect(Math.max(...samplesOf(chunks[1]).map(Math.abs))).toBeGreaterThan(15000);
    cap.stop();
    expect(mic.st.stopped).toBe(1);
    expect(mic.st.closed).toBe(true);
    mic.feed(sine(4096, 48000));
    expect(chunks.length).toBe(4);
    expect(ends).toEqual([]);
  });

  it('a device that goes away ends the capture once', async () => {
    const mic = fakeMic();
    const ends: string[] = [];
    await startCapture(mic.deps, () => {}, (r) => ends.push(r));
    mic.endTrack();
    mic.endTrack();
    expect(ends).toEqual(['ended']);
    expect(mic.st.closed).toBe(true);
  });

  it('a refusal rejects as getUserMedia does', async () => {
    await expect(startCapture(fakeMic(48000, 'NotAllowedError').deps, () => {}, () => {})).rejects.toMatchObject({ name: 'NotAllowedError' });
  });
});

/** The addon in a node Worker: its calls cross to the page as messages and back */
function overMessages() {
  const sent: any[] = [];
  let guest: ReturnType<typeof guestBridge>;
  const server = pageCallServer((m) => { sent.push(m); queueMicrotask(() => guest.receive(m)); });
  guest = guestBridge((m: any) => { if (m.type === PAGE_CALL) queueMicrotask(() => void server.serve(m)); });
  return { bridge: guest, server, sent };
}

describe('audio-capture.node', () => {
  it('records: startRecording is true at once, chunks come as Buffers, stop releases the microphone', async () => {
    const mic = fakeMic(48000);
    setMicDeps(() => mic.deps);
    const { bridge } = overMessages();
    const audio = createAudioCaptureAddon(bridge, { Buffer });
    const data: Uint8Array[] = [];
    let ended = 0;
    expect(audio.startRecording((b) => data.push(b), () => ended++)).toBe(true);
    expect(audio.isRecording()).toBe(true);
    // (one recording at a time)
    expect(audio.startRecording(() => {}, () => {})).toBe(false);
    await tick(10);
    mic.feed(sine(3072, 48000));
    await tick(10);
    expect(data.length).toBe(1);
    expect(Buffer.isBuffer(data[0])).toBe(true);
    expect(data[0].length).toBe(2048);
    expect(audio.microphoneAuthorizationStatus()).toBe(3);
    audio.stopRecording();
    expect(audio.isRecording()).toBe(false);
    await tick(10);
    expect(mic.st.stopped).toBe(1);
    expect(ended).toBe(0);
    // and again
    expect(audio.startRecording(() => {}, () => {})).toBe(true);
    await tick(10);
    audio.stopRecording();
    await tick(10);
    expect(mic.st.stopped).toBe(2);
  });

  it('a stop while the browser is still asking releases the microphone once it answers', async () => {
    const mic = fakeMic(48000);
    let answer!: () => void;
    const slow: MicDeps = { ...mic.deps, getUserMedia: (c) => new Promise((r) => { answer = () => r(mic.deps.getUserMedia(c)); }) };
    setMicDeps(() => slow);
    const audio = createAudioCaptureAddon(overMessages().bridge);
    // (requestMicrophonePermission: start, stop at once)
    expect(audio.startRecording(() => {}, () => {})).toBe(true);
    audio.stopRecording();
    await tick(10);
    answer();
    await tick(10);
    expect(mic.st.stopped).toBe(1);
    expect(audio.isRecording()).toBe(false);
  });

  it('a refusal ends the recording and is remembered: the next start is false, as Claude Code reads a denied microphone', async () => {
    setMicDeps(() => fakeMic(48000, 'NotAllowedError').deps);
    const logs: string[] = [];
    const audio = createAudioCaptureAddon(overMessages().bridge, { log: (s) => logs.push(s) });
    let ended = 0;
    expect(audio.startRecording(() => {}, () => ended++)).toBe(true);
    await tick(10);
    expect(ended).toBe(1);
    expect(audio.isRecording()).toBe(false);
    expect(logs[0]).toMatch(/NotAllowedError/);
    expect(audio.microphoneAuthorizationStatus()).toBe(2);
    expect(audio.startRecording(() => {}, () => {})).toBe(false);
  });

  it('a permission already denied, or no microphone API, makes startRecording false', async () => {
    const denied = createAudioCaptureAddon({ call: async (op) => (op === 'mic.permission' ? 'denied' : true) });
    await tick();
    expect(denied.startRecording(() => {}, () => {})).toBe(false);
    expect(denied.microphoneAuthorizationStatus()).toBe(2);
    setMicDeps(() => null);
    const none = createAudioCaptureAddon(overMessages().bridge);
    await tick(10);
    expect(none.startRecording(() => {}, () => {})).toBe(false);
  });

  it('a device that goes away calls onEnd', async () => {
    const mic = fakeMic();
    setMicDeps(() => mic.deps);
    const audio = createAudioCaptureAddon(overMessages().bridge);
    let ended = 0;
    audio.startRecording(() => {}, () => ended++);
    await tick(10);
    mic.endTrack();
    await tick(10);
    expect(ended).toBe(1);
    expect(audio.isRecording()).toBe(false);
  });

  it("the process's exit, or the page closing its calls, stops a recording left running", async () => {
    const mic = fakeMic();
    setMicDeps(() => mic.deps);
    let exit!: () => void;
    const audio = createAudioCaptureAddon(overMessages().bridge, { onExit: (f) => { exit = f; } });
    audio.startRecording(() => {}, () => {});
    await tick(10);
    exit();
    await tick(10);
    expect(mic.st.stopped).toBe(1);

    const killed = overMessages();
    createAudioCaptureAddon(killed.bridge).startRecording(() => {}, () => {});
    await tick(10);
    killed.server.close();
    await tick(10);
    expect(mic.st.stopped).toBe(2);
  });

  it('plays nothing: no caller in 2.1.296', () => {
    const audio = createAudioCaptureAddon({ call: async () => 'prompt' });
    expect(audio.startPlayback(16000, 1)).toBe(false);
    expect(audio.isPlaying()).toBe(false);
  });
});

describe('the bridge', () => {
  it('errors cross with their names; an unknown call fails', async () => {
    const { bridge } = overMessages();
    await expect(bridge.call('nope', [])).rejects.toThrow('unknown page call nope');
    setMicDeps(() => fakeMic(48000, 'NotFoundError').deps);
    await expect(bridge.call('mic.start', ['s'], () => {})).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it("mic.permission is 'unavailable' without the microphone API", async () => {
    expect(await runPageOp('mic.permission', [], () => {})).toBe('unavailable');
  });
});

describe('/proc/asound/cards', () => {
  it("names the page's microphone as a card when there is getUserMedia, else none", async () => {
    const pfs = new FileSystem();
    await pfs.init();
    vi.stubGlobal('navigator', {});
    expect(await pfs.readFile('/proc/asound/cards', 'utf8')).toBe('--- no soundcards ---\n');
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({}) } });
    const cards = await pfs.readFile('/proc/asound/cards', 'utf8') as string;
    expect(cards).toMatch(/^ 0 \[Browser {8}\]: tabcomputer - /);
    expect(cards.includes('no soundcards')).toBe(false);
    expect(await pfs.readdir('/proc/asound')).toEqual(['cards']);
    expect(await pfs.readdir('/proc')).toContain('asound');
  });
});
