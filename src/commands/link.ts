/**
 * `link`: a link from what was done in this tab (docs/RUN_LINKS.md "link",
 * tabcomputer#147). It reads what was typed at the tab's terminals since the
 * tab was new (src/session-log.ts), writes the shortest script that gets
 * another person to the same place (src/link-trim.ts: rules, no model), and
 * gives the address that carries it after the `#` (src/link-fragment.ts).
 *
 *   link                 the script, what it fits in, what it downloaded here, and the link;
 *                        on the desktop a window where the script can be edited
 *   link --print         the link only
 *   link --script        the script only
 *   link --why           each line that was left out, and why
 *   link -o FILE         write the script to FILE; edit it, then:
 *   link FILE            the link for the script in FILE
 *
 * The person who opens the link is shown the script and chooses Run before
 * anything runs (src/run-url.ts). Nothing here sends the script anywhere.
 *
 * `link FILE1 FILE2` is coreutils' link(1), which this name belonged to: a
 * second name for a file.
 */
import type { Command } from './index';
import type { FileSystem } from '../filesystem';
import { FRAGMENT_MAX, scriptLink, type ScriptLink } from '../link-fragment';
import { FILE_TEXT_MAX, editedPaths, trimSession, type FileNow, type TrimEntry, type Trimmed } from '../link-trim';
import { downloadSentences, sumTally, type TallyRow } from '../net-tally';
import { sessionLog } from '../session-log';
import { DECEPTIVE } from '../run-url';

const USAGE = `Usage: link [--print | --script | --why] [-o FILE] [FILE]

A link from what you did in this tab. link looks at what was typed at this
tab's terminals, keeps the lines that succeeded and changed something, and
writes the address that carries them. The person who opens the address sees
the commands and chooses Run before anything runs.

  link              the script, what it fits in, and the link
  link --print      the link only
  link --script     the script only
  link --why        each line that was left out, and why
  link -o FILE      write the script to FILE; edit it, then: link FILE
  link FILE         the link for the script in FILE
`;

/** What a file holds now: its text when it is small text, else why it cannot go in a link */
export async function fileNow(fs: Pick<FileSystem, 'stat' | 'readFile'>, path: string): Promise<FileNow> {
  const st = await fs.stat(path).catch(() => null);
  if (!st) return { missing: true };
  if (st.type !== 'file') return { skip: 'folder', size: 0 };
  if (st.size > FILE_TEXT_MAX * 4) return { skip: 'large', size: st.size };
  const raw = await fs.readFile(path).catch(() => null);
  if (raw === null) return { missing: true };
  const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw as Uint8Array;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { skip: 'binary', size: bytes.length }; }
  // (what a link's script may not hold, src/run-url.ts: control and invisible characters)
  if (DECEPTIVE.test(text) || text.includes('\r')) return { skip: 'binary', size: bytes.length };
  if (text.length > FILE_TEXT_MAX) return { skip: 'large', size: bytes.length };
  return { text };
}

export interface LinkInput {
  /** The site's origin, without a slash at its end */
  origin: string;
  /** A script the person wrote or edited: the link is made of it as it is */
  script?: string;
  entries?: (TrimEntry & { net?: TallyRow[] })[];
  edits?: { path: string; at: number }[];
  home?: string;
  cwd?: string;
  files?: Map<string, FileNow>;
  linked?: Map<string, string>;
}

export interface MadeLink {
  script: string;
  /** What was kept and dropped (null for a script the person gave) */
  trimmed: Trimmed | null;
  link: ScriptLink;
  /** Which form the script fits, in a sentence */
  sizeLine: string;
  /** What the kept lines downloaded here, by the path it took */
  downloads: { lines: string[]; relayBytes: number; warning: string };
}

const n = (x: number): string => x.toLocaleString('en-US');

/** Which form a script fits, as the sentence under it */
export function sizeSentence(script: string, link: ScriptLink): string {
  if (!script.trim()) return 'There is nothing to put in a link yet: no line typed in this tab changed anything.';
  if (link.form === 'readable') return `The script fits in a link a person can read: ${n(link.url.length)} characters.`;
  if (link.form === 'compressed') return `The script is too long to read in a link, so the link holds it compressed: ${n(link.url.length)} characters. A link holds up to ${n(FRAGMENT_MAX)}.`;
  return `The script is too long for a link: ${n(link.compressed)} characters compressed, and a link holds up to ${n(FRAGMENT_MAX)}. A gist can hold it. Making a gist needs a GitHub sign-in.`;
}

/** The script for a session (or the one given), its link, and the sentences about both */
export async function buildLink(input: LinkInput): Promise<MadeLink> {
  let trimmed: Trimmed | null = null;
  let script = input.script;
  let rows: TallyRow[] = [];
  if (script === undefined) {
    trimmed = trimSession({ entries: input.entries ?? [], edits: input.edits, home: input.home ?? '/home/user', cwd: input.cwd ?? input.home ?? '/home/user', files: input.files ?? new Map(), linked: input.linked });
    script = trimmed.script;
    // What the kept lines downloaded: every time one of them ran and did not fail (the first `pip install` is the one that fetched)
    const keptLines = new Set(trimmed.kept.map((k) => k.line));
    rows = sumTally((input.entries ?? []).filter((e) => keptLines.has(e.line) && (e.status === 0 || e.status === null || e.status === 130)).map((e) => e.net ?? []));
  }
  const link = script.trim() ? await scriptLink(script, input.origin) : { form: 'readable' as const, url: '', readable: 0, compressed: 0 };
  return { script, trimmed, link, sizeLine: sizeSentence(script, link), downloads: downloadSentences(rows) };
}

/** This tab's session, with what its edited files hold now */
export async function gatherSession(fs: Pick<FileSystem, 'stat' | 'readFile'>, home: string, cwd: string): Promise<Required<Pick<LinkInput, 'entries' | 'edits' | 'home' | 'cwd' | 'files' | 'linked'>>> {
  const log = sessionLog();
  const files = new Map<string, FileNow>();
  for (const p of editedPaths(log)) files.set(p, await fileNow(fs, p));
  // A tab that was opened with a link: its commands are kept where it wrote them (src/run-url.ts)
  const linked = new Map<string, string>();
  for (const e of log.entries) {
    const m = /^\.\s+~\/run\/(sh-[0-9a-f]{12})\/\.run-link$/.exec(e.line.trim());
    if (!m || linked.has(m[1])) continue;
    const text = await fs.readFile(`${home}/run/${m[1]}/.recipe.sh`, 'utf8').catch(() => null);
    if (typeof text === 'string') linked.set(m[1], text);
  }
  return { entries: log.entries, edits: log.edits, home, cwd, files, linked };
}

/** The site's origin for links made here (a guest's page shares the site's link, not its own host's) */
async function siteOrigin(): Promise<string> {
  if (typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) return 'https://tabcomputer.com';
  const [{ siteOriginOf }, { guestInfo }] = await Promise.all([import('../apps/share'), import('../guest')]);
  return siteOriginOf(location, !!guestInfo());
}

/** The Link window for this tab's session (the System menu's "Share this setup as a link…") */
export async function openLinkWindow(fs: FileSystem, home: string, cwd: string): Promise<MadeLink> {
  const origin = await siteOrigin();
  const made = await buildLink({ ...(await gatherSession(fs, home, cwd)), origin });
  const [{ showLinkWindow }, { writeClipboard }] = await Promise.all([import('../link-ui'), import('../utils/clipboard')]);
  showLinkWindow(made, {
    wm: (globalThis as { __shiroDesktop?: import('../desktop/wm').DesktopAPI }).__shiroDesktop ?? null,
    origin,
    copy: (text) => writeClipboard(text).catch(() => false),
  });
  return made;
}

const hasDesktop = (): boolean => !!(globalThis as { __shiroDesktop?: unknown }).__shiroDesktop;

export const linkCmd: Command = {
  name: 'link',
  description: 'A link from what you did in this tab: the commands that got here, in one address',
  async exec(ctx) {
    const out = (s = '') => { ctx.stdout += s + '\n'; };
    const err = (s: string) => { ctx.stderr += `link: ${s}\n`; };
    const flags = new Set<string>();
    const rest: string[] = [];
    let outFile = '';
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i];
      if (a === '-o' || a === '--output') { outFile = ctx.args[++i] ?? ''; if (!outFile) { err('-o needs a file name'); return 2; } }
      else if (a === '-h' || a === '--help' || a === 'help') { ctx.stdout += USAGE; return 0; }
      else if (a === '--print' || a === '--script' || a === '--why') flags.add(a);
      else if (a === '--') { rest.push(...ctx.args.slice(i + 1)); break; }
      else if (a.startsWith('-') && a !== '-') { err(`unknown option ${a} (link --help)`); return 2; }
      else rest.push(a);
    }
    // link(1): `link FILE1 FILE2` makes FILE2 another name for FILE1
    if (rest.length === 2 && !flags.size && !outFile) {
      const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
      return ctx.shell.execute(`ln -- ${q(rest[0])} ${q(rest[1])}`, (s) => { ctx.stdout += s; }, (s) => { ctx.stderr += s; }, false, undefined, true);
    }
    if (rest.length > 1) { err('one script file at most (link --help)'); return 2; }
    const home = ctx.env['HOME'] || '/home/user';
    const abs = (p: string) => (p.startsWith('/') ? p : p === '~' ? home : p.startsWith('~/') ? home + p.slice(1) : `${ctx.cwd.replace(/\/$/, '')}/${p}`);
    const origin = await siteOrigin();
    let made: MadeLink;
    if (rest.length) {
      const now = await fileNow(ctx.fs, abs(rest[0]));
      if ('missing' in now) { err(`${rest[0]}: no such file`); return 1; }
      if ('skip' in now) { err(`${rest[0]} ${now.skip === 'folder' ? 'is a folder' : now.skip === 'binary' ? 'is not text, and a link holds text only' : 'is too large for a link'}`); return 1; }
      made = await buildLink({ script: now.text, origin });
    } else made = await buildLink({ ...(await gatherSession(ctx.fs, home, ctx.cwd)), origin });

    if (outFile) {
      await ctx.fs.writeFile(abs(outFile), made.script);
      out(`The script is in ${outFile} (${made.script.split('\n').length - 1} lines). Edit it, then: link ${outFile}`);
      return 0;
    }
    if (flags.has('--script')) { ctx.stdout += made.script; return 0; }
    if (flags.has('--why')) {
      for (const d of made.trimmed?.dropped ?? []) out(`${d.line.split('\n')[0]}\n    left out: ${d.why}`);
      for (const k of made.trimmed?.kept ?? []) out(`${k.line.split('\n')[0]}\n    kept: ${k.why}`);
      return 0;
    }
    if (flags.has('--print')) {
      if (!made.link.url) { err(made.sizeLine); return 1; }
      out(made.link.url);
      return 0;
    }
    if (!made.script.trim()) { out(made.sizeLine); return 0; }
    out('The script:');
    out();
    ctx.stdout += made.script.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n');
    out();
    out(made.sizeLine);
    if (made.trimmed) {
      out(`What the script downloaded here: ${made.downloads.lines.join(' ')}`);
      if (made.downloads.warning) out(made.downloads.warning);
      for (const s of made.trimmed.notInLink) out(s);
      if (made.trimmed.dropped.length) out(`${made.trimmed.dropped.length} ${made.trimmed.dropped.length === 1 ? 'line was' : 'lines were'} left out (link --why says why).`);
    }
    if (made.link.url) { out(); out(made.link.url); out(); out('The person who opens the link sees these commands and chooses Run before anything runs.'); }
    if (hasDesktop() && typeof document !== 'undefined' && ctx.stdoutIsTTY !== false) {
      const [{ showLinkWindow }, { writeClipboard }] = await Promise.all([import('../link-ui'), import('../utils/clipboard')]);
      showLinkWindow(made, { wm: (globalThis as { __shiroDesktop?: import('../desktop/wm').DesktopAPI }).__shiroDesktop ?? null, origin, copy: (text) => writeClipboard(text).catch(() => false) });
      out('The Link window has the script to edit and a Copy link button.');
    } else out('To change the script: link -o setup.sh, edit setup.sh, then link setup.sh.');
    return 0;
  },
};

const GIST_ID = /^[0-9a-f]{5,40}$/;
const GH_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * A script as a secret gist of the person's GitHub account, for a script too
 * long for a link: the link is then `#gist:USER/ID`. It asks for the GitHub
 * sign-in with the desktop's sheet when the tab has none. The script goes to
 * GitHub (through this site's GitHub proxy unless the network mode is
 * private): the one place `link` sends a script anywhere, and only when the
 * person presses the button for it.
 */
export async function makeGist(script: string, origin: string, fetchFn: (url: string, init?: RequestInit) => Promise<Response> = (u, i) => fetch(u, i)): Promise<string> {
  const [{ askGitHubSignIn, resetGitHubNeedDecline }, { githubApiBase }] = await Promise.all([import('../github-needed'), import('../net-mode')]);
  resetGitHubNeedDecline();
  const token = await askGitHubSignIn({ action: 'link', kind: 'account' });
  if (!token) throw new Error('Making a gist needs a GitHub sign-in. No gist was made.');
  let res: Response;
  try {
    res = await fetchFn(`${githubApiBase(typeof location !== 'undefined' ? location.origin : origin)}/gists`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'A tabcomputer setup, made by link', public: false, files: { 'setup.sh': { content: script } } }),
    });
  } catch { throw new Error('GitHub could not be reached. No gist was made.'); }
  if (!res.ok) throw new Error(`GitHub did not make the gist (HTTP ${res.status}).`);
  const g = await res.json().catch(() => null) as { id?: unknown; owner?: { login?: unknown } } | null;
  const id = typeof g?.id === 'string' && GIST_ID.test(g.id) ? g.id : '';
  const login = typeof g?.owner?.login === 'string' && GH_LOGIN.test(g.owner.login) ? g.owner.login : '';
  if (!id || !login) throw new Error('GitHub\'s answer did not name the gist.');
  return `${origin}/#gist:${login}/${id}`;
}
