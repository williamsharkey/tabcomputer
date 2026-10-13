/**
 * gh extensions (tabcomputer#127): `gh extension install|list|remove|
 * upgrade|exec`, and `gh NAME ...` for an installed one. Classroom tools
 * ship this way (Classroom 50's `gh student`).
 *
 * As upstream gh: an extension is a repository named gh-NAME, kept in
 * ~/.local/share/gh/extensions/gh-NAME. One whose latest release carries
 * builds is installed from the linux-amd64 asset (a manifest.yml beside it
 * records the tag) and runs in the x86-64 emulator; otherwise the
 * repository has to hold an executable named gh-NAME, and it is cloned.
 * Either runs with GH_TOKEN set to the tab's GitHub sign-in, which is where
 * an extension's own API calls (go-gh, or `gh api` in a script) find it.
 */
import type { CommandContext } from './index';
import git from './git-cached';
import { ghApi } from './gh';
import { quoteArgsForShell } from '../shell';
import { githubApiBase } from '../net-mode';
import { getShiroOrigin } from '../utils/shiro-origin';

/** The platform of the tab's emulator, as gh names it */
const PLATFORM = 'linux-amd64';
/** Every platform gh builds extensions for: a release with an asset ending in one of them is a precompiled extension */
const DISTS = [
  'aix-ppc64', 'android-386', 'android-amd64', 'android-arm', 'android-arm64', 'darwin-amd64', 'darwin-arm64', 'dragonfly-amd64',
  'freebsd-386', 'freebsd-amd64', 'freebsd-arm', 'freebsd-arm64', 'illumos-amd64', 'ios-amd64', 'ios-arm64', 'js-wasm',
  'linux-386', 'linux-amd64', 'linux-arm', 'linux-arm64', 'linux-loong64', 'linux-mips', 'linux-mips64', 'linux-mips64le', 'linux-mipsle',
  'linux-ppc64', 'linux-ppc64le', 'linux-riscv64', 'linux-s390x', 'netbsd-386', 'netbsd-amd64', 'netbsd-arm', 'netbsd-arm64',
  'openbsd-386', 'openbsd-amd64', 'openbsd-arm', 'openbsd-arm64', 'openbsd-mips64', 'plan9-386', 'plan9-amd64', 'plan9-arm',
  'solaris-amd64', 'wasip1-wasm', 'windows-386', 'windows-amd64', 'windows-arm', 'windows-arm64',
];
/** gh's own commands: an extension can't take one of these names */
export const CORE_COMMANDS = new Set([
  'alias', 'api', 'attestation', 'auth', 'browse', 'cache', 'codespace', 'completion', 'config', 'extension', 'ext', 'extensions',
  'gist', 'gpg-key', 'help', 'issue', 'label', 'org', 'pr', 'project', 'release', 'repo', 'ruleset', 'run', 'search', 'secret',
  'ssh-key', 'status', 'variable', 'version', 'workflow',
]);

interface Asset { name: string; url: string; browser_download_url: string; size: number }
interface Release { tag_name: string; assets: Asset[] }

export interface Extension {
  /** `student` for gh-student */
  name: string;
  /** Its directory */
  dir: string;
  /** The file that runs */
  exe: string;
  kind: 'binary' | 'git' | 'local';
  owner: string;
  repo: string;
  /** A release tag, or the first 8 characters of the cloned commit */
  version: string;
  pinned: boolean;
}

export function extensionsDir(env: Record<string, string>): string {
  const data = env.XDG_DATA_HOME || `${env.HOME || '/home/user'}/.local/share`;
  return `${data}/gh/extensions`;
}

/** The platform an asset is for, when its name ends in one (`gh-x_v1_linux-amd64`, `gh-x-windows-amd64.exe`). */
export function assetPlatform(name: string): string | null {
  const bare = name.replace(/\.exe$/, '');
  return DISTS.find((d) => bare.endsWith(d)) ?? null;
}

/** Whether a release is of a precompiled extension, and its build for the tab. */
export function pickAsset(release: Release | null): { binary: boolean; asset: Asset | null; platforms: string[] } {
  const platforms = [...new Set((release?.assets ?? []).map((a) => assetPlatform(a.name)).filter((p): p is string => !!p))];
  const asset = release?.assets.find((a) => a.name.endsWith(PLATFORM)) ?? null;
  return { binary: platforms.length > 0, asset, platforms };
}

const manifestText = (m: Record<string, string | boolean>): string => Object.entries(m).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n';

function parseManifest(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

async function readExtension(ctx: CommandContext, name: string): Promise<Extension | null> {
  const dir = `${extensionsDir(ctx.env)}/gh-${name}`;
  const exe = `${dir}/gh-${name}`;
  let link = false;
  try { link = (await ctx.fs.lstat(dir)).isSymbolicLink(); } catch { return null; }
  const base: Extension = { name, dir, exe, kind: 'local', owner: '', repo: `gh-${name}`, version: '', pinned: false };
  if (link) return base;
  try {
    const m = parseManifest(await ctx.fs.readFile(`${dir}/manifest.yml`, 'utf8') as string);
    return { ...base, kind: 'binary', owner: m.owner ?? '', repo: m.name ?? base.repo, version: m.tag ?? '', pinned: m.ispinned === 'true' };
  } catch { /* cloned */ }
  if (!(await ctx.fs.exists(`${dir}/.git`))) return (await ctx.fs.exists(exe)) ? base : null;
  const gfs = ctx.fs.toIsomorphicGitFS();
  let version = '';
  let owner = '';
  let repo = base.repo;
  let pinned = false;
  try { version = (await git.resolveRef({ fs: gfs, dir, ref: 'HEAD' })).slice(0, 8); } catch { /* an empty clone */ }
  try {
    const url = (await git.listRemotes({ fs: gfs, dir })).find((r) => r.remote === 'origin')?.url ?? '';
    const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
    if (m) { owner = m[1]; repo = m[2]; }
  } catch { /* no remote */ }
  // (installed with --pin TAG: the tag is the version, as gh shows it)
  for (const f of await ctx.fs.readdir(dir).catch(() => [] as string[])) if (f.startsWith('.pin-')) { pinned = true; version = f.slice(5); }
  return { ...base, kind: 'git', owner, repo, version, pinned };
}

export async function listExtensions(ctx: CommandContext): Promise<Extension[]> {
  const names = await ctx.fs.readdir(extensionsDir(ctx.env)).catch(() => [] as string[]);
  const out: Extension[] = [];
  for (const n of names.sort()) {
    if (!n.startsWith('gh-')) continue;
    const e = await readExtension(ctx, n.slice(3));
    if (e) out.push(e);
  }
  return out;
}

/** The installed extension that provides `gh NAME`, if any. */
export function findExtension(ctx: CommandContext, name: string): Promise<Extension | null> {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? readExtension(ctx, name) : Promise.resolve(null);
}

function say(ctx: CommandContext, text: string): void {
  if (ctx.terminal && ctx.stdoutIsTTY !== false) ctx.terminal.writeOutput(text.replace(/\n/g, '\r\n')); else ctx.stdout += text;
}

const tty = (ctx: CommandContext): boolean => !!ctx.terminal && ctx.stdoutIsTTY !== false;
const ok = (ctx: CommandContext, text: string): void => { if (tty(ctx)) say(ctx, `✓ ${text}\n`); };

async function latestRelease(token: string, owner: string, repo: string, tag?: string): Promise<Release | null | { error: string }> {
  const { status, data } = await ghApi(token, 'GET', `/repos/${owner}/${repo}/releases/${tag ? `tags/${encodeURIComponent(tag)}` : 'latest'}`);
  if (status === 200) return data as Release;
  if (status === 404) return null;
  return { error: `HTTP ${status}: ${data?.message ?? 'no answer from GitHub'}` };
}

/**
 * The bytes of a release asset. Through the site's GitHub route the page can
 * read them; GitHub's own download host sends no CORS headers, so in private
 * network mode (or when that route fails) the curl package fetches the file
 * over the relay, like every other program in the tab.
 */
async function download(ctx: CommandContext, token: string, asset: Asset, dest: string): Promise<string | null> {
  const headers: Record<string, string> = { Accept: 'application/octet-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const api = asset.url.replace(/^https:\/\/api\.github\.com/, githubApiBase(getShiroOrigin()));
  let why = '';
  try {
    const r = await fetch(api, { headers });
    if (r.ok) {
      await ctx.fs.writeFile(dest, new Uint8Array(await r.arrayBuffer()), { mode: 0o755 });
      return null;
    }
    why = `HTTP ${r.status}`;
  } catch (e) { why = (e as Error)?.message ?? String(e); }
  const curl = '/usr/lib/pkg/curl/bin/curl';
  const sh = (line: string) => ctx.shell.execute(line, () => {}, (s: string) => { ctx.stderr += s.replace(/\r\n/g, '\n'); }, false, undefined, true);
  if (!(await ctx.fs.exists(curl).catch(() => false))) {
    say(ctx, 'Installing curl to download it...\n');
    if ((await sh('pkg install curl')) !== 0 || !(await ctx.fs.exists(curl).catch(() => false))) return why || 'could not install the curl package';
  }
  // (a public asset needs no token; it is never put on a command line)
  const code = await sh(`${curl} -fsSL --retry 2 -o ${quoteArgsForShell([dest])} ${quoteArgsForShell([asset.browser_download_url])}`);
  if (code !== 0) return `download failed (curl exit ${code}${why ? `; ${why}` : ''}); see dmesg for the relay`;
  await ctx.fs.chmod(dest, 0o755);
  return null;
}

async function installBinary(ctx: CommandContext, token: string, owner: string, repo: string, release: Release, pinned: boolean): Promise<number> {
  const { asset, platforms } = pickAsset(release);
  if (!asset) {
    ctx.stderr += `${repo} unsupported for ${PLATFORM} (its release has ${platforms.join(', ')}; this computer runs ${PLATFORM} programs). `
      + `Open an issue: \`gh issue create -R ${owner}/${repo} -t'Support ${PLATFORM}'\`\n`;
    return 1;
  }
  const dir = `${extensionsDir(ctx.env)}/${repo}`;
  await ctx.fs.mkdir(dir, { recursive: true });
  const failed = await download(ctx, token, asset, `${dir}/${repo}`);
  if (failed) {
    await ctx.fs.rm(dir, { recursive: true }).catch(() => {});
    ctx.stderr += `failed to download asset ${asset.name}: ${failed}\n`;
    return 1;
  }
  await ctx.fs.writeFile(`${dir}/manifest.yml`, manifestText({ owner, name: repo, host: 'github.com', tag: release.tag_name, ispinned: pinned, path: `${dir}/${repo}` }));
  return 0;
}

async function installGit(ctx: CommandContext, token: string, owner: string, repo: string, pin: string): Promise<number> {
  const has = await ghApi(token, 'GET', `/repos/${owner}/${repo}/contents/${repo}${pin ? `?ref=${encodeURIComponent(pin)}` : ''}`);
  if (has.status === 404) {
    const exists = await ghApi(token, 'GET', `/repos/${owner}/${repo}`);
    ctx.stderr += exists.status === 404
      ? `Could not find extension '${owner}/${repo}' on host github.com${token ? '' : ' (a private repository needs a GitHub sign-in: gh auth login)'}\n`
      : 'extension is not installable: missing executable\n';
    return 1;
  }
  if (has.status !== 200) { ctx.stderr += `HTTP ${has.status}: ${has.data?.message ?? 'no answer from GitHub'}\n`; return 1; }
  const dir = `${extensionsDir(ctx.env)}/${repo}`;
  await ctx.fs.mkdir(extensionsDir(ctx.env), { recursive: true });
  let err = '';
  const code = await ctx.shell.execute(
    `git clone ${pin ? `--branch ${quoteArgsForShell([pin])} ` : ''}${quoteArgsForShell([`https://github.com/${owner}/${repo}.git`, dir])}`,
    () => {}, (s: string) => { err += s; });
  if (code !== 0) {
    await ctx.fs.rm(dir, { recursive: true }).catch(() => {});
    ctx.stderr += err.replace(/\r\n/g, '\n') || 'git clone failed\n';
    return code;
  }
  await ctx.fs.chmod(`${dir}/${repo}`, 0o755).catch(() => {});
  if (pin) await ctx.fs.writeFile(`${dir}/.pin-${pin}`, '');
  return 0;
}

async function install(ctx: CommandContext, token: string, target: string, pin: string, force: boolean): Promise<number> {
  // A folder of this computer: the extension is whatever is there now and later (a symbolic link)
  if (target === '.' || target.startsWith('./') || target.startsWith('/') || target.startsWith('~')) {
    const dir = ctx.fs.resolvePath(target, ctx.cwd);
    const base = dir.split('/').filter(Boolean).pop() ?? '';
    if (!base.startsWith('gh-')) { ctx.stderr += 'extension repository name must start with `gh-`\n'; return 1; }
    if (!(await ctx.fs.exists(`${dir}/${base}`))) { ctx.stderr += `${base} is not installable: no executable named ${base} in it\n`; return 1; }
    const link = `${extensionsDir(ctx.env)}/${base}`;
    await ctx.fs.mkdir(extensionsDir(ctx.env), { recursive: true });
    if (await ctx.fs.lstat(link).then(() => true, () => false)) {
      if (!force) { ctx.stderr += `there is already an installed extension that provides the "${base.slice(3)}" command\n`; return 1; }
      await ctx.fs.rm(link, { recursive: true });
    }
    await ctx.fs.symlink(dir, link);
    return 0;
  }
  const m = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(target);
  if (!m) { ctx.stderr += `expected the "OWNER/REPO" format, got "${target}"\n`; return 1; }
  const [, owner, repo] = m;
  if (!repo.startsWith('gh-')) { ctx.stderr += 'extension repository name must start with `gh-`\n'; return 1; }
  const name = repo.slice(3);
  if (CORE_COMMANDS.has(name)) { ctx.stderr += `"${name}" matches the name of a built-in command or alias\n`; return 1; }
  const existing = await readExtension(ctx, name);
  if (existing) {
    if (!force) { ctx.stderr += `there is already an installed extension that provides the "${name}" command\n`; return 1; }
    return upgradeOne(ctx, token, existing, true, false);
  }
  const release = await latestRelease(token, owner, repo, pin || undefined);
  if (release && 'error' in release) { ctx.stderr += `${release.error}\n`; return 1; }
  const code = pickAsset(release).binary
    ? await installBinary(ctx, token, owner, repo, release!, !!pin)
    : await installGit(ctx, token, owner, repo, pin);
  if (code !== 0) return code;
  ok(ctx, `Installed extension ${owner}/${repo}`);
  if (pin) ok(ctx, `Pinned extension at ${pin}`);
  return 0;
}

/** Upgrade one extension. 0, or 1 with the reason on stderr. */
async function upgradeOne(ctx: CommandContext, token: string, e: Extension, force: boolean, dryRun: boolean): Promise<number> {
  const note = (text: string) => say(ctx, `[${e.name}]: ${text}\n`);
  if (e.kind === 'local') { note('local extensions can not be upgraded'); return 1; }
  if (e.pinned && !force) { note('pinned extensions can not be upgraded'); return 1; }
  if (e.kind === 'binary') {
    const release = await latestRelease(token, e.owner, e.repo);
    if (!release || 'error' in release) { note(release ? release.error : 'no release found'); return 1; }
    if (release.tag_name === e.version) { note('already up to date'); return 0; }
    if (!dryRun) {
      const code = await installBinary(ctx, token, e.owner, e.repo, release, false);
      if (code !== 0) return code;
    }
    note(`${dryRun ? 'would have upgraded' : 'upgraded'} from ${e.version} to ${release.tag_name}`);
    return 0;
  }
  const gfs = ctx.fs.toIsomorphicGitFS();
  if (dryRun) {
    // (what GitHub has, without fetching it)
    const branch = await git.currentBranch({ fs: gfs, dir: e.dir }).catch(() => undefined) || 'main';
    const head = await ghApi(token, 'GET', `/repos/${e.owner}/${e.repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    const sha = head.status === 200 ? String(head.data?.object?.sha ?? '').slice(0, 8) : '';
    note(!sha || sha === e.version ? 'already up to date' : `would have upgraded from ${e.version} to ${sha}`);
    return 0;
  }
  let err = '';
  const q = quoteArgsForShell([e.dir]);
  for (const f of await ctx.fs.readdir(e.dir).catch(() => [] as string[])) if (f.startsWith('.pin-')) await ctx.fs.unlink(`${e.dir}/${f}`).catch(() => {});
  const code = await ctx.shell.execute(`cd ${q} && git pull`, () => {}, (s: string) => { err += s; });
  if (code !== 0) { note(err.replace(/\r\n/g, '\n').trim().split('\n').pop() || 'git pull failed'); return 1; }
  const now = (await git.resolveRef({ fs: gfs, dir: e.dir, ref: 'HEAD' }).catch(() => '')).slice(0, 8);
  note(now === e.version ? 'already up to date' : `upgraded from ${e.version} to ${now}`);
  return 0;
}

/**
 * Run an installed extension with the caller's terminal and stdin, GH_TOKEN
 * set to the tab's GitHub sign-in when there is one.
 */
export async function runExtension(ctx: CommandContext, e: Extension, args: string[], token: string): Promise<number> {
  if (!(await ctx.fs.exists(e.exe))) { ctx.stderr += `gh ${e.name}: its program is missing (${e.exe}). Run: gh extension install --force ${e.owner ? `${e.owner}/${e.repo}` : e.dir}\n`; return 1; }
  const toTerm = tty(ctx);
  const child = ctx.shell.fork();
  if (ctx.terminal) child.setTerminal(ctx.terminal as never);
  child.cwd = ctx.cwd;
  child.env = { ...child.env, ...(token && !ctx.env.GH_TOKEN ? { GH_TOKEN: token } : {}) };
  const out = (s: string) => { if (toTerm) ctx.terminal!.writeOutput(s); else ctx.stdout += s.replace(/\r\n/g, '\n'); };
  const err = (s: string) => { if (ctx.terminal && ctx.stderrIsTTY !== false) ctx.terminal.writeOutput(s); else ctx.stderr += s.replace(/\r\n/g, '\n'); };
  return child.executeWithStdinOf(ctx, quoteArgsForShell([e.exe, ...args]), ctx.streamStdout ?? out, ctx.streamStderr ?? err);
}

const USAGE = `Work with gh extensions: repositories named gh-NAME that add \`gh NAME\`.

USAGE
  gh extension install OWNER/REPO [--pin TAG] [--force]
  gh extension list
  gh extension upgrade {NAME | --all} [--force] [--dry-run]
  gh extension remove NAME
  gh extension exec NAME [ARG...]

A precompiled extension is installed from its release's ${PLATFORM} build; one written
as a script is cloned. Either runs with GH_TOKEN set from this computer's GitHub sign-in.
`;

export async function ghExtensionHandler(ctx: CommandContext, token: string): Promise<number> {
  const sub = ctx.args[1];
  const rest = ctx.args.slice(2);
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') { ctx.stdout += USAGE; return 0; }
  const flag = (name: string) => { const i = rest.indexOf(name); if (i < 0) return false; rest.splice(i, 1); return true; };
  switch (sub) {
    case 'install': {
      let pin = '';
      const p = rest.findIndex((a) => a === '--pin' || a.startsWith('--pin='));
      if (p >= 0) pin = rest[p].includes('=') ? rest.splice(p, 1)[0].slice(6) : rest.splice(p, 2)[1] ?? '';
      const force = flag('--force');
      const unknown = rest.find((a) => a.startsWith('-') && a !== '.');
      if (unknown) { ctx.stderr += `unknown flag: ${unknown}\n\nUsage:  gh extension install <repository> [flags]\n`; return 1; }
      if (rest.length !== 1) { ctx.stderr += 'must specify a repository to install from\n\nUsage:  gh extension install <repository> [flags]\n'; return 1; }
      return install(ctx, token, rest[0], pin, force);
    }
    case 'list': case 'ls': {
      const all = await listExtensions(ctx);
      if (!all.length) { ctx.stderr += 'no installed extensions found\n'; return 1; }
      const rows = all.map((e) => [`gh ${e.name}`, e.owner ? `${e.owner}/${e.repo}` : '', e.version]);
      if (!tty(ctx)) { ctx.stdout += rows.map((r) => r.join('\t')).join('\n') + '\n'; return 0; }
      const table = [['NAME', 'REPO', 'VERSION'], ...rows];
      const w = [0, 1].map((i) => Math.max(...table.map((r) => r[i].length)));
      say(ctx, table.map((r) => `${r[0].padEnd(w[0])}  ${r[1].padEnd(w[1])}  ${r[2]}`.trimEnd()).join('\n') + '\n');
      return 0;
    }
    case 'remove': case 'rm': case 'uninstall': {
      const name = (rest[0] ?? '').replace(/^gh-/, '');
      if (!name) { ctx.stderr += 'accepts 1 arg(s), received 0\n\nUsage:  gh extension remove <name>\n'; return 1; }
      const e = await findExtension(ctx, name);
      if (!e) { ctx.stderr += `no extension found: "${name}"\n`; return 1; }
      if (e.kind === 'local') await ctx.fs.unlink(e.dir); else await ctx.fs.rm(e.dir, { recursive: true });
      ok(ctx, `Removed extension ${name}`);
      return 0;
    }
    case 'upgrade': {
      const all = flag('--all');
      const force = flag('--force');
      const dryRun = flag('--dry-run');
      const name = (rest[0] ?? '').replace(/^gh-/, '');
      if (!all && !name) { ctx.stderr += 'specify an extension to upgrade or `--all`\n'; return 1; }
      if (all && name) { ctx.stderr += 'cannot use `--all` with extension name\n'; return 1; }
      const targets = all ? await listExtensions(ctx) : [await findExtension(ctx, name)].filter((e): e is Extension => !!e);
      if (!targets.length) { ctx.stderr += all ? 'no installed extensions found\n' : `no extension matched "${name}"\n`; return 1; }
      let failed = false;
      for (const e of targets) {
        // (with --all, the ones that can't move are skipped quietly, as in gh)
        if (all && (e.kind === 'local' || (e.pinned && !force))) continue;
        if ((await upgradeOne(ctx, token, e, force, dryRun)) !== 0) failed = true;
      }
      if (failed) { ctx.stderr += 'Failed upgrading extensions\n'; return 1; }
      ok(ctx, 'Successfully checked extension upgrades');
      return 0;
    }
    case 'exec': {
      const name = (rest[0] ?? '').replace(/^gh-/, '');
      const e = name ? await findExtension(ctx, name) : null;
      if (!e) { ctx.stderr += name ? `extension "${name}" not found\n` : 'accepts at least 1 arg(s), received 0\n'; return 1; }
      return runExtension(ctx, e, rest.slice(1), token);
    }
    case 'create': case 'browse': case 'search':
      ctx.stderr += `gh extension ${sub} is not part of this gh; install, list, upgrade, remove and exec are.\n`;
      return 1;
    default:
      ctx.stderr += `unknown command "${sub}" for "gh extension"\n\n${USAGE}`;
      return 1;
  }
}
