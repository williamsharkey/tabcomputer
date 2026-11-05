/**
 * The preinstalled Claude Code: tabcomputer's pinned native release, ready for
 * `claude` (which runs `--vm`) without `claude install`. Only the part of the
 * binary `--vm` runs is downloaded: byte ranges of the site's copy of
 * Anthropic's unchanged release file (server.mjs /claude-releases/,
 * remote-graph.ts), ~55 of 315 MB, then laid out as for an installed binary
 * (extract.ts), under the same key (the release's sha256).
 *
 * The profile's `preinstall: claude-native` does it in the background after
 * boot (main.ts); a `claude` typed before that finished does the rest itself.
 * A binary the user installed (`claude install`, `claude update`) at
 * $CLAUDE_NATIVE_PATH takes precedence over this one (claude.ts runVm).
 */
import { claudeVmLayoutDir, ensureClaudeVmLayout, VM_LAYOUT, type VmFs, type VmLayout } from './extract';
import { decodeLayoutPack, materializeLayout } from './layout-pack';
import { fetchBunGraph, httpRangeGet } from './remote-graph';

/** The release tabcomputer preinstalls; checked with this build's Bun shim (docs/CLAUDE_VM.md) */
export const CLAUDE_VM_PINNED = {
  version: '2.1.316',
  platform: 'linux-x64-musl',
  /** From the release's manifest.json: the server keeps the file only if it matches */
  sha256: '8bc3d015479b8b87dfde3f69f9bdb96c658758a8eb31892fd8fbece8d8a08bcf',
  size: 314779944,
} as const;

/** What a launch reads to know the preinstalled build is ready (and which) */
export const PREINSTALL_RECORD = '/var/lib/tabcomputer/claude-vm.json';

export interface PreinstallOptions {
  /** The page's origin (getShiroOrigin) */
  origin: string;
  fetch?: typeof fetch;
  say?: (s: string) => void;
  /** Another release than the pinned one (tests) */
  release?: { version: string; platform: string; sha256: string; size: number };
  /**
   * After the layout is on disk: compile its modules without starting Claude
   * Code (warm.ts). A failure leaves `claude` to compile as it runs.
   */
  warm?: (dir: string) => Promise<void>;
}

export function pinnedReleaseUrl(origin: string, p: { version: string; platform: string } = CLAUDE_VM_PINNED): string {
  return `${origin.replace(/\/+$/, '')}/claude-releases/${p.version}/${p.platform}/claude`;
}

/** The offline layout for this release and this VM_LAYOUT, one gzip file */
export function prebuiltLayoutUrl(origin: string, sha: string): string {
  return `${origin.replace(/\/+$/, '')}/claude-vm-layout/${sha}/${VM_LAYOUT}/pack`;
}

const prebuiltFlights = new Map<string, Promise<VmLayout | null>>();

/**
 * The prepared layout, if this site has one for `sha`. A miss (404, an older
 * server, a layout this build does not use) is null and the caller transforms
 * the release itself. Callers of one sha share one download.
 */
export function installPrebuiltLayout(fs: VmFs, home: string, opts: PreinstallOptions & { sha256: string; version: string }): Promise<VmLayout | null> {
  const key = `${home}\0${opts.sha256}`;
  let flight = prebuiltFlights.get(key);
  if (!flight) {
    flight = downloadPrebuilt(fs, home, opts).finally(() => prebuiltFlights.delete(key));
    prebuiltFlights.set(key, flight);
  }
  return flight;
}

async function downloadPrebuilt(fs: VmFs, home: string, opts: PreinstallOptions & { sha256: string; version: string }): Promise<VmLayout | null> {
  const say = opts.say ?? (() => {});
  const dirEarly = claudeVmLayoutDir(home, opts.sha256);
  try {
    const mark = await fs.readFile(`${dirEarly}/complete`, 'utf8');
    if (String(mark).trim() === String(VM_LAYOUT)) return { dir: dirEarly, launcher: `${dirEarly}/vm-main.mjs`, sha256: opts.sha256, extracted: false };
  } catch { /* not laid out yet */ }
  const fetchFn = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(prebuiltLayoutUrl(opts.origin, opts.sha256), { priority: 'low' } as RequestInit);
  } catch { return null; }
  if (!res.ok) return null;
  say(`Downloading prepared Claude Code ${opts.version}...\n`);
  const t0 = Date.now();
  const buf = new Uint8Array(await res.arrayBuffer());
  say(`  ${Math.round(buf.length / 2 ** 20)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
  let decoded;
  try { decoded = decodeLayoutPack(buf); } catch { return null; }
  if (decoded.sha256 !== opts.sha256 || decoded.vmLayout !== VM_LAYOUT) return null;
  const dir = dirEarly;
  const made = new Set<string>();
  let modules: Uint8Array | null = null;
  for (const f of materializeLayout(decoded.files, decoded.placeholder, dir)) {
    const path = `${dir}/${f.rel}`;
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (!made.has(parent)) { made.add(parent); await fs.mkdir(parent, { recursive: true }); }
    if (f.rel === 'modules.js') modules = f.bytes;
    await fs.writeFile(path, f.bytes);
  }
  if (modules) {
    const { putModules } = await import('./module-store');
    await putModules(dir, modules).catch(() => {});
  }
  await fs.writeFile(`${dir}/complete`, String(VM_LAYOUT));
  say('  prepared layout ready\n');
  return { dir, launcher: `${dir}/vm-main.mjs`, sha256: opts.sha256, extracted: true };
}

/**
 * The preinstalled build's layout, downloaded and made first if needed. Throws
 * when the site can't send it (no /claude-releases/, or no byte ranges: shiro,
 * older servers), so the caller says how to install it instead.
 */
export async function ensurePreinstalledClaudeVm(fs: VmFs, home: string, opts: PreinstallOptions): Promise<VmLayout & { version: string }> {
  const p = opts.release ?? CLAUDE_VM_PINNED;
  const say = opts.say ?? (() => {});
  const prebuilt = await installPrebuiltLayout(fs, home, { ...opts, sha256: p.sha256, version: p.version, say });
  if (prebuilt) {
    try {
      await fs.mkdir(PREINSTALL_RECORD.slice(0, PREINSTALL_RECORD.lastIndexOf('/')), { recursive: true });
      await fs.writeFile(PREINSTALL_RECORD, JSON.stringify({ version: p.version, platform: p.platform, sha256: p.sha256 }, null, 2) + '\n');
    } catch { /* only a record */ }
    return { ...prebuilt, version: p.version };
  }
  const layout = await ensureClaudeVmLayout(fs, p.sha256, home, async () => {
    say(`Downloading Claude Code ${p.version} (the part tabcomputer runs, about 55 MB)...\n`);
    const t0 = Date.now();
    let shown = 0;
    const { graph, bytes } = await fetchBunGraph(p.size, httpRangeGet(pinnedReleaseUrl(opts.origin, p), opts.fetch), {
      onProgress: (n) => {
        if (n - shown < 16 * 2 ** 20) return;
        shown = n;
        say(`  ${Math.round(n / 2 ** 20)} MB\n`);
      },
    });
    say(`  ${Math.round(bytes / 2 ** 20)} MB in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
    return graph;
  }, say);
  try {
    await fs.mkdir(PREINSTALL_RECORD.slice(0, PREINSTALL_RECORD.lastIndexOf('/')), { recursive: true });
    await fs.writeFile(PREINSTALL_RECORD, JSON.stringify({ version: p.version, platform: p.platform, sha256: p.sha256 }, null, 2) + '\n');
  } catch { /* only a record */ }
  return { ...layout, version: p.version };
}

/**
 * The boot's background preinstall (main.ts): skipped where the user's own
 * binary is installed (that one runs), and where the browser's storage quota
 * leaves no room for the layout (~200 MB).
 */
export async function preinstallClaudeVmInBackground(fs: VmFs, home: string, nativePath: string, opts: PreinstallOptions): Promise<'ready' | 'skipped'> {
  try {
    if ((await fs.stat(nativePath)).size > 0) return 'skipped';
  } catch { /* no binary of the user's: preinstall */ }
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota && est.quota - (est.usage ?? 0) < 400 * 2 ** 20) return 'skipped';
  } catch { /* unknown: go on */ }
  const ready = await ensurePreinstalledClaudeVm(fs, home, opts);
  if (opts.warm) {
    try { await opts.warm(ready.dir); }
    catch (e: any) { console.warn('[tabcomputer] Claude Code module warm-up failed:', e?.message || e); }
  }
  // (the CA roots it checks for at start: claude.ts ensureCaBundle)
  await import('../commands/claude').then((m) => m.ensureCaBundle(fs as any)).catch(() => {});
  return 'ready';
}
