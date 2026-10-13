/**
 * /usr/bin/apt and /usr/bin/apt-get in Debian mode (the overlay diverts
 * Debian's to apt.debian and apt-get.debian): Debian's apt with recovery in
 * front of the commands that change packages, so a browser tab doesn't need
 * a Debian admin's know-how after something went wrong.
 *
 * - dpkg was interrupted (its journal, /var/lib/dpkg/updates, isn't empty):
 *   `dpkg --configure -a` first, as apt's own message says to.
 * - packages left half-installed, unpacked or half-configured: `apt-get -f
 *   install -y` first, as apt's "Try 'apt --fix-broken install'" says to.
 * - the command fails and leaves either behind (an unpack that failed
 *   mid-way, e.g. a transient engine fault): recover, then run it once more.
 *   The archives of the failed run are still in /var/cache/apt/archives, so
 *   the retry doesn't download them again.
 *
 * - an install with no package lists yet (a fresh Debian, or one that came
 *   with a toolchain layer) runs `apt-get update` first, and one that fails
 *   with "Unable to locate package" fetches the lists and runs once more,
 *   unless they were fetched in the last ten minutes.
 *
 * At the prompt the commands that change packages or the lists run as root
 * without `sudo` (`aptWantsRoot`; shiroAptCmd in src/commands/debian.ts):
 * one person uses this machine, as with `apt` before Debian mode.
 *
 * Everything else (search, show, policy, non-root runs) goes straight
 * to Debian's apt. Messages are prefixed with the product name so they read
 * as the system's, not apt's.
 */
import type { Kernel } from '../kernel/kernel';
import type { Process } from '../kernel/process';
import { WIFEXITED, WEXITSTATUS } from '../kernel/abi';

const DEBIAN_SUFFIX = '.debian';
const UPDATES = '/var/lib/dpkg/updates';
const TORN = '/var/lib/dpkg/updates.torn';
const CHANGES = new Set(['install', 'reinstall', 'remove', 'purge', 'upgrade', 'full-upgrade', 'dist-upgrade', 'autoremove', 'autopurge', 'build-dep', 'satisfy']);
/** Commands that resolve package names against the lists. */
const NEEDS_LISTS = new Set(['install', 'reinstall', 'upgrade', 'full-upgrade', 'dist-upgrade', 'build-dep', 'satisfy']);
/** Commands apt refuses to a user who is not root. */
const ROOT_ONLY = new Set([...CHANGES, 'update', 'clean', 'autoclean']);
const LISTS = '/var/lib/apt/lists';
const NOT_FOUND = /Unable to locate package|has no installation candidate/;
/** When this page last fetched the lists: a name apt still can't find after that is a wrong name. */
let listsFetchedAt = 0;
const LISTS_FRESH_MS = 10 * 60_000;

/** Forget that the lists were fetched (tests). */
export function resetAptListsFetched(): void {
  listsFetchedAt = 0;
}

/** apt and apt-get commands that need root: the prompt runs them as root without `sudo`. */
export function aptWantsRoot(args: string[]): boolean {
  const sub = aptSubcommand(args);
  return !!sub && ROOT_ONLY.has(sub);
}

/** dpkg statuses that mean an operation stopped part-way (dpkg --audit lists these). */
const BROKEN = /^(half-installed|unpacked|half-configured)$/;

/** Programs that configure packages through debconf (Debian's own behind the overlay too). */
const DEBCONF_PROGRAMS = /^(?:apt|apt-get|aptitude|dpkg|dpkg-reconfigure)(?:\.debian)?$/;

/**
 * The environment for apt or dpkg started without a terminal:
 * DEBIAN_FRONTEND=noninteractive unless the user set one. debconf can't ask
 * there; it tries each frontend and says so on every install ("unable to
 * initialize frontend: Readline ... falling back to frontend: Noninteractive").
 */
export function debconfEnv(program: string, env: Record<string, string>, hasTty: boolean): Record<string, string> {
  if (hasTty || env.DEBIAN_FRONTEND !== undefined || !DEBCONF_PROGRAMS.test(program.slice(program.lastIndexOf('/') + 1))) return env;
  return { ...env, DEBIAN_FRONTEND: 'noninteractive' };
}

/** The apt subcommand: the first argument that isn't an option (or an option's value). */
export function aptSubcommand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '-c' || a === '-t' || a === '--option' || a === '--config-file' || a === '--target-release') { i++; continue; }
    if (!a.startsWith('-')) return a;
  }
  return undefined;
}

/** Packages dpkg left part-way, from /var/lib/dpkg/status. */
export function brokenPackages(status: string): string[] {
  const out: string[] = [];
  for (const stanza of status.split(/\n\n+/)) {
    const name = /^Package: (.+)$/m.exec(stanza)?.[1];
    const st = /^Status: \S+ \S+ (\S+)$/m.exec(stanza)?.[1];
    if (name && st && BROKEN.test(st)) out.push(name);
  }
  return out;
}

/** What the guard needs from whoever runs it (a kernel process or Shiro's shell). */
export interface AptGuardIO {
  /** /usr/bin/apt-get or /usr/bin/apt (Debian's is this + .debian). */
  script: string;
  args: string[];
  uid: number;
  fs?: {
    readdir(p: string): Promise<string[]>;
    readFile(p: string, enc: 'utf8'): Promise<string | Uint8Array>;
    rename?(from: string, to: string): Promise<void>;
    mkdir?(p: string, opts?: { recursive?: boolean }): Promise<unknown>;
  };
  /** Run a program to completion: its exit status. */
  run(path: string, argv: string[]): Promise<number>;
  say(line: string): Promise<void> | void;
  /** What the runs have printed so far, when the caller sees it (the shell does; a kernel process's children write to its fds). */
  output?(): string;
  /** The caller is gone (Ctrl-C, a timeout, a kill): start nothing more. */
  stopped?(): boolean;
}

/** Ended by a signal (Ctrl-C 130, kill 137, SIGTERM 143), not by apt: no recovery or retry. */
const KILLED = new Set([130, 137, 143]);

/** The recovery logic, independent of how programs are run. */
export async function aptGuard(io: AptGuardIO, product = 'tabcomputer'): Promise<number> {
  const { script, args, fs } = io;
  const stopped = () => !!io.stopped?.();
  // A run started after the caller went away would outlive it holding dpkg's lock
  const run = (path: string, argv: string[]) => (stopped() ? Promise.resolve(130) : io.run(path, argv));
  const real = () => run(script + DEBIAN_SUFFIX, [script, ...args]);
  const sub = aptSubcommand(args);
  const dry = args.some((a) => /^(-s|--simulate|--just-print|--dry-run|--recon|--no-act|--print-uris|-d|--download-only)$/.test(a));
  if (sub === 'update' && !dry) {
    const code = await real();
    if (code === 0) listsFetchedAt = Date.now();
    return code;
  }
  if (!fs || io.uid !== 0 || !sub || !CHANGES.has(sub) || dry) return real();

  const say = async (s: string) => { await io.say(`${product}: ${s}\n`); };
  const needsLists = NEEDS_LISTS.has(sub);
  const noLists = async () => !(await fs.readdir(LISTS).catch(() => [] as string[])).some((f) => /_Packages(\.\w+)?$/.test(f));
  const fetchLists = async (): Promise<void> => {
    if (await run('/usr/bin/apt-get' + DEBIAN_SUFFIX, ['apt-get', 'update']) === 0) listsFetchedAt = Date.now();
  };
  const interrupted = async () => (await fs.readdir(UPDATES).catch(() => [] as string[])).some((f) => /^\d+$/.test(f));
  const broken = async () => brokenPackages(String(await fs.readFile('/var/lib/dpkg/status', 'utf8').catch(() => '')));
  // dpkg's journal entries are status stanzas; one torn by a crash makes every
  // dpkg run fail to parse it. Keep it aside, as an admin would.
  const tornAside = async (): Promise<void> => {
    if (!fs.rename || !fs.mkdir) return;
    for (const f of await fs.readdir(UPDATES).catch(() => [] as string[])) {
      if (!/^\d+$/.test(f)) continue;
      const text = String(await fs.readFile(`${UPDATES}/${f}`, 'utf8').catch(() => ''));
      if (/^Package: \S/m.test(text) && /^Status: \S+ \S+ \S+$/m.test(text)) continue;
      await fs.mkdir(TORN, { recursive: true }).catch(() => {});
      await fs.rename(`${UPDATES}/${f}`, `${TORN}/${f}`).catch(() => {});
      await say(`dpkg's journal entry ${f} was incomplete; moved it to ${TORN}`);
    }
  };
  const recover = async (): Promise<void> => {
    if (await interrupted()) {
      await tornAside();
      await say("dpkg was interrupted; running 'dpkg --configure -a' first");
      await run('/usr/bin/dpkg', ['dpkg', '--configure', '-a']);
    }
    const left = await broken();
    if (left.length) {
      await say(`finishing what an earlier install left part-way (${left.slice(0, 5).join(', ')}${left.length > 5 ? ', …' : ''}): apt-get -f install`);
      await run('/usr/bin/apt-get' + DEBIAN_SUFFIX, ['apt-get', '-f', 'install', '-y']);
    }
  };

  await recover();
  if (stopped()) return 130;
  if (needsLists && await noLists()) {
    await say("no package lists yet; running 'apt-get update' first");
    await fetchLists();
    if (stopped()) return 130;
  }
  const seen = io.output?.().length ?? 0;
  let code = await real();
  if (code !== 0 && !KILLED.has(code) && !stopped() && needsLists && Date.now() - listsFetchedAt > LISTS_FRESH_MS
    && NOT_FOUND.test(io.output?.().slice(seen) ?? '')) {
    await say("fetching the package lists ('apt-get update') and trying once more");
    await fetchLists();
    if (stopped()) return 130;
    code = await real();
  }
  if (code === 0 || KILLED.has(code) || stopped() || !['install', 'reinstall', 'upgrade', 'full-upgrade', 'dist-upgrade'].includes(sub)) return code;
  // A failed run that left dpkg part-way: recover and try once more
  if (!(await interrupted()) && !(await broken()).length) return code;
  await say('the install stopped part-way; recovering and trying once more');
  await recover();
  return stopped() ? 130 : real();
}

/** Runner for `shiro-apt` as a kernel program (the stub's argv is [interp, /usr/bin/apt-get, ...args]). */
export async function aptGuardProgram(proc: Process, kernel: Kernel, product = 'tabcomputer'): Promise<number> {
  // (started by a program rather than the shell: the shell's own runs get this in runKernelPipeline)
  const env = debconfEnv('apt', proc.env, !!proc.ctty);
  const run = async (path: string, argv: string[]): Promise<number> => {
    const child = kernel.spawn({ path, argv, env, cwd: proc.cwd, parent: proc, inheritSignals: true });
    const r = await kernel.waitpid(child.pid, 0, proc);
    if (r.pid < 0) return 127;
    return WIFEXITED(r.status) ? WEXITSTATUS(r.status) : 128 + (r.status & 0x7f);
  };
  return aptGuard({
    script: proc.argv[1]?.startsWith('/') ? proc.argv[1] : '/usr/bin/apt-get',
    args: proc.argv.slice(2),
    uid: proc.uid,
    fs: kernel.fs ?? undefined,
    run,
    say: async (s) => { await proc.fds.get(2)?.write(new TextEncoder().encode(s)); },
    stopped: () => proc.exiting,
  }, product);
}
