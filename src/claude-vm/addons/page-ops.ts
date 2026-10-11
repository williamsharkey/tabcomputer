/**
 * What the addon stand-ins ask of the page (bridge.ts), run in the page:
 *
 *   clipboard.write [text]          → true (the text is kept when the browser refuses: utils/clipboard.ts)
 *   clipboard.read [timeoutMs]      → the clipboard's text, '' when unreadable or out of time
 *   mic.permission []               → 'granted' | 'denied' | 'prompt' | 'unavailable'
 *   mic.start [session]             → resolves once recording; events { pcm } then, if it ends by itself, { end } (last)
 *   mic.stop [session]              → true
 */
import { readClipboard, writeClipboard } from '../../utils/clipboard';
import { browserMicDeps, micPermission, startCapture, type Capture, type MicDeps } from './mic';

/** Recordings by session (each process's addon names its own), with how to end its events */
const captures = new Map<string, { cap: Capture; end(reason: string): void } | 'starting'>();
/** Stops asked for while getUserMedia was still pending (its prompt open) */
const stopEarly = new Set<string>();

let micDeps: () => MicDeps | null = browserMicDeps;
/** (tests) The browser APIs the microphone uses */
export function setMicDeps(f: () => MicDeps | null): void { micDeps = f; }

export async function runPageOp(op: string, args: unknown[], emit: (ev: unknown, last?: boolean) => void): Promise<unknown> {
  switch (op) {
    case 'clipboard.write':
      await writeClipboard(String(args[0] ?? ''));
      return true;
    case 'clipboard.read': {
      const ms = typeof args[0] === 'number' && args[0] > 0 ? args[0] : 2000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<string>((r) => { timer = setTimeout(() => r(''), ms); });
      try { return await Promise.race([readClipboard(), late]); } finally { clearTimeout(timer); }
    }
    case 'mic.permission':
      return micDeps() ? micPermission() : 'unavailable';
    case 'mic.start': {
      const session = String(args[0]);
      const deps = micDeps();
      if (!deps) throw Object.assign(new Error('this browser has no microphone API'), { name: 'NotSupportedError' });
      if (captures.has(session)) throw Object.assign(new Error('already recording'), { name: 'InvalidStateError' });
      captures.set(session, 'starting');
      // (the last event frees the guest's side of the call: on a stop too)
      const end = (reason: string) => { captures.delete(session); emit({ end: reason }, true); };
      let cap: Capture;
      try {
        cap = await startCapture(deps, (pcm) => emit({ pcm }), end);
      } catch (e) {
        captures.delete(session);
        stopEarly.delete(session);
        throw e;
      }
      if (stopEarly.delete(session)) { cap.stop(); end('stopped'); return false; }
      captures.set(session, { cap, end });
      return true;
    }
    case 'mic.stop': {
      const session = String(args[0]);
      const cap = captures.get(session);
      if (cap === 'starting') stopEarly.add(session);
      else if (cap) { cap.cap.stop(); cap.end('stopped'); }
      return true;
    }
  }
  throw new Error(`unknown page call ${op}`);
}
