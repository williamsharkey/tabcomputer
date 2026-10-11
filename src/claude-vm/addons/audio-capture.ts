/**
 * audio-capture.node for claude --vm (voice input): the page's microphone.
 *
 * Claude Code 2.1.296 (chunk "audio-capture-napi") uses the addon on Linux
 * when it loads and /proc/asound/cards names a card (filesystem.ts lists the
 * page's microphone there); otherwise it tries arecord, then SoX's rec.
 *
 *   startRecording(onData, onEnd) → true when recording started. onData gets
 *     each chunk of signed 16-bit little-endian PCM, 16 kHz, mono (Claude Code
 *     makes it a Buffer, measures its level, and sends it on the voice
 *     stream). onEnd: the recording ended by itself; Claude Code only listens
 *     with silence detection on, which its voice mode turns off.
 *   stopRecording(), isRecording()
 *   microphoneAuthorizationStatus() → macOS's AVAuthorizationStatus
 *     (0 not determined, 2 denied, 3 authorized); unused on Linux.
 *   startPlayback, writePlaybackData, stopPlayback, isPlaying: nothing in
 *     2.1.296 plays audio through the addon; playback isn't available here.
 *
 * startRecording answers at once, but the browser asks the user first
 * (getUserMedia). So it returns false only when the permission is already
 * known to be denied (Claude Code then says "Microphone access is denied"
 * from /voice, or tries its other recorders); a refusal that comes later
 * ends the recording (onEnd) and is remembered for the next start.
 */
import type { PageBridge } from './bridge';

type Permission = 'granted' | 'denied' | 'prompt' | 'unavailable';

export interface AudioCaptureAddon {
  startRecording(onData: (chunk: Uint8Array) => void, onEnd: () => void): boolean;
  stopRecording(): void;
  isRecording(): boolean;
  microphoneAuthorizationStatus(): number;
  startPlayback(sampleRate?: number, channels?: number): boolean;
  writePlaybackData(data: Uint8Array): void;
  stopPlayback(): void;
  isPlaying(): boolean;
}

export interface AudioCaptureEnv {
  /** Chunks as Buffers, as the native addon hands them */
  Buffer?: { from(b: ArrayBuffer, off: number, len: number): Uint8Array };
  /** The process's exit: a recording left running is stopped */
  onExit?(fn: () => void): void;
  log?(msg: string): void;
}

let sessions = 0;
const instance = Math.random().toString(36).slice(2, 8);

export function createAudioCaptureAddon(page: PageBridge, env: AudioCaptureEnv = {}): AudioCaptureAddon {
  let permission: Permission = 'prompt';
  let current: string | null = null;
  const log = env.log ?? (() => {});
  // (what a start found out since wins over this answer)
  void page.call('mic.permission', []).then((p) => { if (typeof p === 'string' && permission === 'prompt') permission = p as Permission; }, () => {});
  const toChunk = (b: Uint8Array) => (env.Buffer ? env.Buffer.from(b.buffer as ArrayBuffer, b.byteOffset, b.byteLength) : b);

  const stop = () => {
    const s = current;
    if (!s) return;
    current = null;
    void page.call('mic.stop', [s]).catch(() => {});
  };
  env.onExit?.(stop);

  return {
    startRecording(onData, onEnd) {
      if (current || permission === 'denied' || permission === 'unavailable') return false;
      const s = `${instance}-${++sessions}`;
      current = s;
      const ended = () => {
        if (current !== s) return;
        current = null;
        onEnd();
      };
      page.call('mic.start', [s], (ev) => {
        if (current !== s) return;
        const e = ev as { pcm?: Uint8Array; end?: string };
        if (e.pcm) onData(toChunk(e.pcm));
        if (e.end) ended();
      }).then((started) => {
        if (started) permission = 'granted';
      }, (err: Error) => {
        if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') permission = 'denied';
        else if (err?.name === 'NotSupportedError') permission = 'unavailable';
        log(`[voice] microphone: ${err?.name ?? 'Error'}: ${err?.message ?? err}`);
        ended();
      });
      return true;
    },
    stopRecording: stop,
    isRecording: () => current !== null,
    microphoneAuthorizationStatus: () => (permission === 'granted' ? 3 : permission === 'denied' ? 2 : 0),
    startPlayback: () => false,
    writePlaybackData() {},
    stopPlayback() {},
    isPlaying: () => false,
  };
}
