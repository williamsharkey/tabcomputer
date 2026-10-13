/**
 * Restart on save (docs/APPS.md, `app dev`): a change to a file of an app's
 * folder reloads its page; a change outside the page's folder restarts the
 * backend first; a change to app.json reads the manifest again (an invalid
 * one is reported and the last valid one stays). `app dev` and the Code app's
 * app pane (app-pane.ts) both watch with this.
 */
import { MANIFEST_FILE } from './manifest';
import { loadManifest, type RegistryFs } from './registry';
import type { AppInstance } from './runtime';
import { PAGE_SET_TIMEOUT, PAGE_CLEAR_TIMEOUT } from '../node-compat/page-globals';

export interface WatchFs extends RegistryFs {
  onChange(cb: (ev: string, path: string, newPath?: string) => void): () => void;
}

/** Watch `dir` for `inst`. `say` gets a line for each thing done. Returns the function that stops watching. */
export function watchAppDir(fs: WatchFs, dir: string, inst: AppInstance, say: (line: string) => void): () => void {
  const changed = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const apply = async () => {
    timer = null;
    const rels = [...changed];
    changed.clear();
    let restart = false;
    if (rels.includes(MANIFEST_FILE)) {
      try {
        inst.setManifest(await loadManifest(fs, dir));
        say(`[app] ${MANIFEST_FILE} changed: read again`);
        restart = !!inst.supervisor;
      } catch (e) { say(`[app] ${MANIFEST_FILE} changed and is not valid; the app keeps the last valid one:\n${(e as Error).message}`); return; }
    }
    const m = inst.manifest;
    const pageRoot = !m.entry ? '' : /\.html?$/i.test(m.entry) ? m.entry.split('/').slice(0, -1).join('/') : m.entry === '.' ? '' : m.entry;
    const backendFiles = rels.filter((r) => r !== MANIFEST_FILE && inst.supervisor && (m.entry === '.' || !pageRoot || !(r === pageRoot || r.startsWith(pageRoot + '/'))));
    if (backendFiles.length) restart = true;
    const shown = rels.slice(0, 3).join(', ') + (rels.length > 3 ? `, and ${rels.length - 3} more` : '');
    if (restart && inst.supervisor) {
      say(`[app] changed: ${shown}: restarting the backend`);
      await inst.supervisor.restart();
    } else say(`[app] changed: ${shown}: reloading the page`);
    inst.reload();
  };
  const off = fs.onChange((_ev, path) => {
    if (path !== dir && !path.startsWith(dir + '/')) return;
    const rel = path.slice(dir.length + 1);
    if (!rel || /(^|\/)(node_modules|\.git)(\/|$)/.test(rel) || /(^|\/)\.[^/]*\.sw.$|~$/.test(rel)) return;
    changed.add(rel);
    if (timer) PAGE_CLEAR_TIMEOUT(timer);
    timer = PAGE_SET_TIMEOUT(() => { void apply(); }, 200);
  });
  return () => { off(); if (timer) PAGE_CLEAR_TIMEOUT(timer); };
}
