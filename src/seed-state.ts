/**
 * What a seed carries, and what an import may change (src/commands/seed.ts,
 * the import paths in src/main.ts).
 *
 * A seed is a copy of the machine: every file, and localStorage. It is made
 * to be handed on (a link anyone can open, a GIF, a snippet pasted into
 * another site), so by default it carries no credentials:
 *   - the files src/credentials.ts lists (Claude's, ssh keys, netrc, gh's
 *     hosts file, cloud CLIs…), .env files, and any file that contains
 *     something shaped like a token or a private key are left out;
 *   - git config, .npmrc, shell startup files and histories keep everything
 *     but the lines with a login in them;
 *   - of localStorage only layout and preferences go (an allowlist: the
 *     console log, the copies node keeps of ~/.claude files and anything
 *     nobody listed stay behind).
 * collectSeedState returns what was left out, by name, so the command can
 * say it. `withCredentials` (moving your own machine) keeps all of it except
 * what would let someone drive this tab.
 *
 * Importing replaces the file tree, but never the importer's sign-ins: their
 * credential files are kept, and a seed's localStorage never overwrites a
 * credential entry or brings a remote-control code.
 */

import type { FileSystem, FSNode } from './filesystem';
import {
  CREDENTIAL_HOME_FILES, HOME_DIRS, SHAREABLE_STORAGE_KEYS, WAL_STORAGE_PREFIX,
  credentialFileReason, scrubCredentialLines, storageCredentialKind, storageCredentialName,
} from './credentials';

export const SEED_VERSION = '0.1.0';

/** Files larger than this are judged by path only (no seed that fits a share holds a bigger text file) */
const SCAN_MAX_BYTES = 1024 * 1024;

export interface SeedLeftOut {
  /** Files left out whole, and why */
  files: { path: string; why: string }[];
  /** Files kept without some lines */
  scrubbed: { path: string; removed: string[] }[];
  /** localStorage entries left out because they are (or look like) a credential, by name */
  credentials: string[];
  /** Other localStorage entries left out (not preferences): key names */
  storage: string[];
}

export interface SeedStats {
  version: string;
  files: number;
  dirs: number;
  totalBytes: number;
  sizeKB: number;
  sizeMB: string;
  /** Names of credentials the seed carries (only with withCredentials) */
  detectedKeys: string[];
}

export interface SeedState {
  ndjson: string;
  storageJson: string;
  stats: SeedStats;
  left: SeedLeftOut;
  withCredentials: boolean;
}

type ExportFs = Pick<FileSystem, 'exportAll'>;
interface StorageLike { readonly length: number; key(i: number): string | null; getItem(k: string): string | null; setItem(k: string, v: string): void }

function uint8ToBase64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The file's text, or null when it is binary or too big to look into */
function textOf(content: Uint8Array | null | undefined): string | null {
  if (!content || content.length > SCAN_MAX_BYTES) return null;
  const head = content.subarray(0, 4096);
  for (let i = 0; i < head.length; i++) if (head[i] === 0) return null;
  try { return new TextDecoder('utf-8', { fatal: false }).decode(content); } catch { return null; }
}

/**
 * The machine's state as a seed carries it. Without `withCredentials` the
 * result holds no credential the lists and patterns in src/credentials.ts
 * know, and `left` says what stayed behind.
 */
export async function collectSeedState(fs: ExportFs, opts: { withCredentials?: boolean; storage?: StorageLike } = {}): Promise<SeedState> {
  const withCredentials = !!opts.withCredentials;
  const storageSource = opts.storage ?? localStorage;
  const left: SeedLeftOut = { files: [], scrubbed: [], credentials: [], storage: [] };
  const carried = new Set<string>();
  const nodes = await fs.exportAll();
  let files = 0, dirs = 0, totalBytes = 0;
  const lines: string[] = [];

  for (const node of nodes) {
    let content = node.content ?? null;
    let size = node.size;
    if (node.type === 'file') {
      const text = textOf(content);
      const why = credentialFileReason(node.path, text);
      const scrub = !why && text !== null ? scrubCredentialLines(node.path, text) : null;
      if (withCredentials) {
        if (why) carried.add(`${node.path} (${why})`);
        else if (scrub) carried.add(`${node.path} (${scrub.removed.join(', ')})`);
      } else if (why) {
        left.files.push({ path: node.path, why });
        continue;
      } else if (scrub) {
        left.scrubbed.push({ path: node.path, removed: scrub.removed });
        content = new TextEncoder().encode(scrub.text);
        size = content.length;
      }
      files++;
      totalBytes += size || 0;
    } else if (node.type === 'dir') {
      dirs++;
    }
    lines.push(JSON.stringify({
      path: node.path, type: node.type,
      content: content ? uint8ToBase64(content) : null,
      mode: node.mode, mtime: node.mtime, ctime: node.ctime,
      size, symlinkTarget: node.symlinkTarget,
    }));
  }

  const storage: Record<string, string> = {};
  for (let i = 0; i < storageSource.length; i++) {
    const key = storageSource.key(i)!;
    const value = storageSource.getItem(key) ?? '';
    const kind = storageCredentialKind(key, value);
    // What lets someone drive this tab goes nowhere, whatever was asked
    if (kind === 'control') { left.credentials.push(storageCredentialName(key)); continue; }
    if (withCredentials) {
      if (kind === 'credential') carried.add(storageCredentialName(key));
      storage[key] = value;
    } else if (kind === 'credential') left.credentials.push(storageCredentialName(key));
    else if (!SHAREABLE_STORAGE_KEYS.has(key)) left.storage.push(key);
    else storage[key] = value;
  }
  left.credentials.sort();
  left.storage.sort();

  return {
    ndjson: lines.join('\n'),
    storageJson: JSON.stringify(storage),
    stats: {
      version: SEED_VERSION, files, dirs, totalBytes,
      sizeKB: Math.round(totalBytes / 1024), sizeMB: (totalBytes / (1024 * 1024)).toFixed(2),
      detectedKeys: [...carried].sort(),
    },
    left,
    withCredentials,
  };
}

/** What the command prints about what a seed does not carry (or, with credentials, what it does). */
export function describeSeedContents(state: SeedState): string {
  const { left } = state;
  let out = '';
  if (state.withCredentials) {
    out += `\n  \x1b[1;31mWARNING: this seed carries your credentials.\x1b[0m Whoever gets it is signed in as you.\n`;
    if (state.stats.detectedKeys.length) {
      out += `  Included:\n`;
      for (const k of state.stats.detectedKeys) out += `    - ${k}\n`;
    } else out += `  (No credential was found, but nothing was left out either.)\n`;
    if (left.credentials.length) out += `  Never included: ${left.credentials.join(', ')}\n`;
    return out;
  }
  const nothing = !left.files.length && !left.scrubbed.length && !left.credentials.length && !left.storage.length;
  if (nothing) return `\n  Credentials: none found, nothing left out.\n`;
  out += `\n  Left out (a seed carries no credentials):\n`;
  for (const f of left.files) out += `    - ${f.path}  (${f.why})\n`;
  for (const f of left.scrubbed) out += `    - ${f.path}: kept, without ${f.removed.join(', ')}\n`;
  for (const c of left.credentials) out += `    - saved in the browser: ${c}\n`;
  if (left.storage.length) out += `    - other browser storage that is not layout or preferences: ${left.storage.join(', ')}\n`;
  if (!left.files.length && !left.scrubbed.length && !left.credentials.length) out += `    (no credential was found)\n`;
  return out;
}

// ── Import ──

type ImportFs = Pick<FileSystem, 'importAll' | 'readFile' | 'writeFile' | 'mkdir' | 'readdir' | 'stat'>;

/** The importer's own credential files, as they are now */
async function ownCredentialFiles(fs: ImportFs): Promise<{ path: string; content: Uint8Array; mode?: number }[]> {
  const kept: { path: string; content: Uint8Array; mode?: number }[] = [];
  const take = async (path: string) => {
    try {
      const st = await fs.stat(path);
      if (st.isDirectory()) return;
      const content = await fs.readFile(path);
      kept.push({ path, content: typeof content === 'string' ? new TextEncoder().encode(content) : content, mode: st.mode });
    } catch { /* not there */ }
  };
  const walk = async (dir: string, depth = 0): Promise<void> => {
    let names: string[] = [];
    try { names = await fs.readdir(dir); } catch { return; }
    for (const name of names) {
      const path = `${dir}/${name}`;
      let isDir = false;
      try { isDir = (await fs.stat(path)).isDirectory(); } catch { continue; }
      if (isDir) { if (depth < 6) await walk(path, depth + 1); } else if (credentialFileReason(path, null)) await take(path);
    }
  };
  for (const home of HOME_DIRS) {
    for (const f of CREDENTIAL_HOME_FILES) {
      if (f.dir) await walk(`${home}/${f.path}`); else await take(`${home}/${f.path}`);
    }
    await walk(`${home}/.ssh`);
  }
  return kept;
}

export interface SeedImportResult {
  /** The importer's credential files, kept over whatever the seed had there */
  keptFiles: string[];
  /** localStorage entries of the seed that were not applied, by name */
  skippedStorage: string[];
}

/**
 * Replace this machine's files with a seed's, and apply its localStorage,
 * without touching the importer's sign-ins:
 *   - the importer's credential files (src/credentials.ts) are put back after
 *     the tree is replaced, over anything the seed had at those paths;
 *   - a credential entry in the seed's localStorage is applied only where the
 *     importer has none (moving your own machine to a new browser), a
 *     remote-control code or a `wal:` copy never.
 */
export async function importSeedState(
  fs: ImportFs, nodes: FSNode[], storage: Record<string, unknown> | string | null | undefined,
  opts: { storage?: StorageLike } = {},
): Promise<SeedImportResult> {
  const target = opts.storage ?? localStorage;
  const kept = await ownCredentialFiles(fs);
  await fs.importAll(nodes);
  for (const f of kept) {
    try {
      await fs.mkdir(f.path.slice(0, f.path.lastIndexOf('/')) || '/', { recursive: true });
      await fs.writeFile(f.path, f.content, f.mode !== undefined ? { mode: f.mode } as never : undefined);
    } catch (e) { console.warn(`[seed] could not keep ${f.path}:`, e); }
  }
  const skippedStorage: string[] = [];
  let entries: Record<string, unknown> = {};
  try { entries = (typeof storage === 'string' ? JSON.parse(storage) : storage) || {}; } catch { entries = {}; }
  for (const [key, raw] of Object.entries(entries)) {
    const value = String(raw);
    const kind = storageCredentialKind(key, value);
    const own = target.getItem(key);
    if (kind === 'control' || key.startsWith(WAL_STORAGE_PREFIX) || (kind === 'credential' && own !== null && own !== '')) {
      skippedStorage.push(storageCredentialName(key));
      continue;
    }
    target.setItem(key, value);
  }
  return { keptFiles: kept.map((f) => f.path), skippedStorage };
}

/** Parse a seed's NDJSON into nodes (content decoded), yielding to the page between batches. */
export async function parseSeedNdjson(ndjson: string, batch = 100): Promise<FSNode[]> {
  const nodes: FSNode[] = [];
  for (const raw of ndjson.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const node = JSON.parse(line);
    nodes.push({ ...node, content: node.content ? Uint8Array.from(atob(node.content), (c: string) => c.charCodeAt(0)) : null });
    if (nodes.length % batch === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return nodes;
}

/** What a person is asked before a shared seed (/s/:id) replaces this machine. */
export function sharedSeedQuestion(id: string, envelope: { files?: number; hostname?: string; timestamp?: number }): string {
  const from = envelope.hostname ? ` made on ${String(envelope.hostname).slice(0, 60)}` : '';
  const when = envelope.timestamp ? ` on ${new Date(envelope.timestamp).toISOString().slice(0, 10)}` : '';
  return `Load the shared seed "${id}"${from}${when}?\n\n`
    + `It replaces every file in this tabcomputer with its ${Number(envelope.files) || 0} files. `
    + `Its programs and startup scripts then run here, and can read anything this tabcomputer is signed in to `
    + `(your sign-ins are kept, not replaced).\n\n`
    + `Only continue if you trust whoever sent the link. Cancel leaves everything as it is.`;
}
