/**
 * The native addons in native Claude Code's bundle (loader napi in the Bun
 * graph), as claude --vm loads them: browser-backed stand-ins with the
 * addons' exports, by file name. docs/CLAUDE_VM.md, "Native addons".
 */
import { directBridge, type PageBridge } from './bridge';
import { createClipboardAddon } from './clipboard-napi';
import { createAudioCaptureAddon, type AudioCaptureEnv } from './audio-capture';

export type { PageBridge } from './bridge';

export interface AddonEnv extends AudioCaptureEnv {
  /** The page's operations: over messages in a node Worker, else directBridge() */
  page?: PageBridge;
}

const MAKERS: Record<string, (page: PageBridge, env: AddonEnv) => unknown> = {
  'clipboard-napi.node': (page) => createClipboardAddon(page),
  'audio-capture.node': (page, env) => createAudioCaptureAddon(page, env),
};

/**
 * A loader for one process: the stand-in for the addon at `path`, the same
 * object each time (a module's exports), or a throw as a failed dlopen.
 */
export function addonLoader(env: AddonEnv): (path: string) => unknown {
  const loaded = new Map<string, unknown>();
  return (path) => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const make = MAKERS[name];
    if (!make) throw Object.assign(new Error(`Cannot load native addon ${path} in claude --vm`), { code: 'ERR_DLOPEN_FAILED' });
    if (!loaded.has(name)) loaded.set(name, make(env.page ?? directBridge(), env));
    return loaded.get(name);
  };
}
