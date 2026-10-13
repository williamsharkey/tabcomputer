/**
 * shiro-apt (src/debian/apt-guard.ts): Debian's apt-get with recovery in
 * front, against a mock kernel whose "dpkg" and "apt-get.debian" edit a fake
 * /var/lib/dpkg the way an interrupted run leaves it.
 */
import { describe, it, expect } from 'vitest';
import { aptGuard, aptGuardProgram, aptSubcommand, aptWantsRoot, brokenPackages, resetAptListsFetched } from '@shiro/debian/apt-guard';
import { shiroAptCmd } from '@shiro/commands/debian';

const STATUS_OK = 'Package: jq\nStatus: install ok installed\nVersion: 1.7\n\nPackage: libjq1\nStatus: install ok installed\n';
const STATUS_BROKEN = 'Package: jq\nStatus: install reinstreq half-installed\n\nPackage: libonig5\nStatus: install ok unpacked\n\nPackage: hello\nStatus: install ok installed\n';

function machine(opts: { status: string; lists?: string[]; updates?: string[]; journal?: Record<string, string>; uid?: number; behave: (argv: string[], m: any) => number }) {
  const calls: string[] = [];
  const m: any = { status: opts.status, lists: opts.lists ?? ['deb.debian.org_debian_dists_trixie_main_binary-amd64_Packages'], updates: opts.updates ?? [], journal: opts.journal, stderr: '' };
  const proc: any = {
    argv: ['/usr/bin/shiro-apt', '/usr/bin/apt-get', 'install', '-y', 'jq'], env: {}, cwd: '/root', uid: opts.uid ?? 0,
    fds: new Map([[2, { write: async (b: Uint8Array) => { m.stderr += new TextDecoder().decode(b); return b.length; } }]]),
  };
  let next = 100;
  const exits = new Map<number, number>();
  const kernel: any = {
    fs: {
      readdir: async (p: string) => { if (p === '/var/lib/dpkg/updates') return m.updates; if (p === '/var/lib/apt/lists') return m.lists; throw new Error('ENOENT'); },
      readFile: async (p: string) => {
        if (p === '/var/lib/dpkg/status') return m.status;
        if (p.startsWith('/var/lib/dpkg/updates/')) return m.journal?.[p.slice(22)] ?? '';
        throw new Error('ENOENT');
      },
      mkdir: async () => {},
      rename: async (from: string) => { m.updates = m.updates.filter((f: string) => from !== `/var/lib/dpkg/updates/${f}`); m.moved = [...(m.moved ?? []), from]; },
    },
    spawn: (o: any) => { calls.push([o.path, ...o.argv.slice(1)].join(' ')); const pid = next++; exits.set(pid, opts.behave([o.path, ...o.argv.slice(1)], m)); return { pid }; },
    waitpid: async (pid: number) => ({ pid, status: (exits.get(pid) ?? 0) << 8 }),
  };
  return { proc, kernel, calls, m };
}

describe('shiro-apt (apt recovery)', () => {
  it('finds the subcommand past options and their values', () => {
    expect(aptSubcommand(['-y', '-o', 'Dpkg::Use-Pty=0', 'install', 'jq'])).toBe('install');
    expect(aptSubcommand(['--option', 'install', 'update'])).toBe('update');
    expect(aptSubcommand(['-qq'])).toBeUndefined();
  });

  it('lists the packages dpkg left part-way', () => {
    expect(brokenPackages(STATUS_OK)).toEqual([]);
    expect(brokenPackages(STATUS_BROKEN)).toEqual(['jq', 'libonig5']);
  });

  it('a healthy system runs Debian\'s apt-get once, with the same arguments', async () => {
    const { proc, kernel, calls, m } = machine({ status: STATUS_OK, behave: () => 0 });
    expect(await aptGuardProgram(proc, kernel)).toBe(0);
    expect(calls).toEqual(['/usr/bin/apt-get.debian install -y jq']);
    expect(m.stderr).toBe('');
  });

  it('an interrupted dpkg and half-installed packages are recovered before the install', async () => {
    const { proc, kernel, calls, m } = machine({
      status: STATUS_BROKEN, updates: ['0001'], journal: { '0001': 'Package: jq\nStatus: install reinstreq half-installed\n' },
      behave: (argv, m) => {
        if (argv[1] === '--configure') m.updates = [];
        if (argv.includes('-f')) m.status = STATUS_OK;
        return 0;
      },
    });
    expect(await aptGuardProgram(proc, kernel)).toBe(0);
    expect(calls).toEqual(['/usr/bin/dpkg --configure -a', '/usr/bin/apt-get.debian -f install -y', '/usr/bin/apt-get.debian install -y jq']);
    expect(m.stderr).toMatch(/^tabcomputer: dpkg was interrupted/);
    expect(m.stderr).toMatch(/jq, libonig5/);
  });

  it('a torn journal entry (no status stanza) is moved aside before dpkg --configure -a', async () => {
    const { proc, kernel, calls, m } = machine({ status: STATUS_OK, updates: ['0003', '0004', 'tmp.i'], behave: () => 0 });
    m.journal = { '0003': 'Package: jq\nStatus: install ok unpacked\n', '0004': 'Package: li' };
    expect(await aptGuardProgram(proc, kernel)).toBe(0);
    expect(m.moved).toEqual(['/var/lib/dpkg/updates/0004']);
    expect(calls[0]).toBe('/usr/bin/dpkg --configure -a');
    expect(m.stderr).toMatch(/journal entry 0004 was incomplete/);
  });

  it('an install that fails part-way is recovered and retried once', async () => {
    let installs = 0;
    const { proc, kernel, calls, m } = machine({
      status: STATUS_OK,
      behave: (argv, m) => {
        if (argv.includes('-f')) { m.status = STATUS_OK; return 0; }
        if (argv.includes('jq') && ++installs === 1) { m.status = STATUS_BROKEN; return 100; } // unpack failed
        return 0;
      },
    });
    expect(await aptGuardProgram(proc, kernel)).toBe(0);
    expect(calls).toEqual(['/usr/bin/apt-get.debian install -y jq', '/usr/bin/apt-get.debian -f install -y', '/usr/bin/apt-get.debian install -y jq']);
    expect(m.stderr).toMatch(/trying once more/);
  });

  it('a clean failure (nothing left part-way) is not retried; read-only, simulated and non-root runs go straight through', async () => {
    const fail = machine({ status: STATUS_OK, behave: () => 100 });
    expect(await aptGuardProgram(fail.proc, fail.kernel)).toBe(100);
    expect(fail.calls).toHaveLength(1);
    for (const [argv, uid] of [[['update'], 0], [['install', '-s', 'jq'], 0], [['install', 'jq'], 1000]] as const) {
      const { proc, kernel, calls } = machine({ status: STATUS_BROKEN, updates: ['0001'], uid, behave: () => 0 });
      proc.argv = ['/usr/bin/shiro-apt', '/usr/bin/apt', ...argv];
      expect(await aptGuardProgram(proc, kernel)).toBe(0);
      expect(calls).toEqual([`/usr/bin/apt.debian ${argv.join(' ')}`]);
    }
  });

  it('a run ended by a signal is not retried, and nothing starts once the caller is gone', async () => {
    // Ctrl-C (130) mid-unpack leaves dpkg part-way, but the user asked it to stop
    const killed = machine({ status: STATUS_OK, behave: (argv, m) => { if (argv.includes('jq')) { m.status = STATUS_BROKEN; return 130; } return 0; } });
    expect(await aptGuardProgram(killed.proc, killed.kernel)).toBe(130);
    expect(killed.calls).toHaveLength(1);
    // The caller went away during the first run (a timeout's abort): no recovery, no retry
    let gone = false;
    const stop = machine({ status: STATUS_OK, behave: (argv, m) => { if (argv.includes('jq')) { m.status = STATUS_BROKEN; gone = true; return 100; } return 0; } });
    Object.defineProperty(stop.proc, 'exiting', { get: () => gone });
    expect(await aptGuardProgram(stop.proc, stop.kernel)).toBe(100);
    expect(stop.calls).toEqual(['/usr/bin/apt-get.debian install -y jq']);
  });

  it('an install with no package lists fetches them first (#133)', async () => {
    resetAptListsFetched();
    const { proc, kernel, calls, m } = machine({ status: STATUS_OK, lists: ['lock', 'partial'], behave: () => 0 });
    expect(await aptGuardProgram(proc, kernel)).toBe(0);
    expect(calls).toEqual(['/usr/bin/apt-get.debian update', '/usr/bin/apt-get.debian install -y jq']);
    expect(m.stderr).toBe("tabcomputer: no package lists yet; running 'apt-get update' first\n");
    // remove needs no lists
    const rm = machine({ status: STATUS_OK, lists: [], behave: () => 0 });
    rm.proc.argv = ['/usr/bin/shiro-apt', '/usr/bin/apt', 'remove', '-y', 'jq'];
    expect(await aptGuardProgram(rm.proc, rm.kernel)).toBe(0);
    expect(rm.calls).toEqual(['/usr/bin/apt.debian remove -y jq']);
  });

  it('"Unable to locate package" fetches the lists and tries once more, but not right after an update', async () => {
    resetAptListsFetched();
    const { kernel } = machine({ status: STATUS_OK, behave: () => 0 });
    const guard = (args: string[], behave: (argv: string[]) => number) => {
      const calls: string[] = [];
      let printed = '';
      let said = '';
      const p = aptGuard({
        script: '/usr/bin/apt', args, uid: 0, fs: kernel.fs,
        run: async (path, argv) => {
          calls.push([path, ...argv.slice(1)].join(' '));
          const code = behave(argv.slice(1));
          if (code === 100) printed += 'E: Unable to locate package cowsay\n';
          return code;
        },
        say: (s) => { said += s; },
        output: () => printed,
      });
      return p.then((code) => ({ code, calls, said }));
    };
    let fetched = false;
    const stale = (argv: string[]) => { if (argv[0] === 'update') { fetched = true; return 0; } return fetched ? 0 : 100; };
    const first = await guard(['install', '-y', 'cowsay'], stale);
    expect(first.code).toBe(0);
    expect(first.calls).toEqual(['/usr/bin/apt.debian install -y cowsay', '/usr/bin/apt-get.debian update', '/usr/bin/apt.debian install -y cowsay']);
    expect(first.said).toMatch(/fetching the package lists .* trying once more/);
    // the lists are fresh now: a name apt can't find is a wrong name, said once
    const typo = await guard(['install', '-y', 'cowsya'], () => 100);
    expect(typo.code).toBe(100);
    expect(typo.calls).toEqual(['/usr/bin/apt.debian install -y cowsya']);
    // the user's own `apt update` counts as fresh too
    resetAptListsFetched();
    await guard(['update'], () => 0);
    expect((await guard(['install', 'cowsya'], () => 100)).calls).toHaveLength(1);
    // another failure is not a reason to fetch
    resetAptListsFetched();
    expect((await guard(['install', 'jq'], () => 1)).calls).toHaveLength(1);
  });

  it('at the prompt, the commands that need root run as root without sudo', async () => {
    expect(aptWantsRoot(['install', '-y', 'cowsay'])).toBe(true);
    expect(aptWantsRoot(['-y', 'remove', 'cowsay'])).toBe(true);
    expect(aptWantsRoot(['update'])).toBe(true);
    expect(aptWantsRoot(['upgrade'])).toBe(true);
    expect(aptWantsRoot(['search', 'cow'])).toBe(false);
    expect(aptWantsRoot(['list', '--installed'])).toBe(false);
    expect(aptWantsRoot([])).toBe(false);

    resetAptListsFetched();
    const { kernel } = machine({ status: STATUS_OK, behave: () => 0 });
    const runs: { line: string; uid: number; path: string; user: string }[] = [];
    const shell: any = {
      uid: 1000, env: { PATH: '/usr/bin:/usr/games', USER: 'user' },
      fork() {
        const child: any = { uid: this.uid, env: { ...this.env } };
        child.executeWithStdin = async (line: string) => { runs.push({ line, uid: child.uid, path: child.env.PATH, user: child.env.USER }); return 0; };
        return child;
      },
    };
    const ctx = (args: string[]): any => ({ args, env: shell.env, stdin: '', stdout: '', stderr: '', fs: kernel.fs, shell });
    expect(await shiroAptCmd.exec(ctx(['/usr/bin/apt', 'install', '-y', 'cowsay']))).toBe(0);
    expect(runs).toEqual([{ line: "'/usr/bin/apt.debian' 'install' '-y' 'cowsay'", uid: 0, path: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/bin:/usr/games', user: 'root' }]);
    runs.length = 0;
    expect(await shiroAptCmd.exec(ctx(['/usr/bin/apt', 'show', 'cowsay']))).toBe(0);
    expect(runs).toEqual([{ line: "'/usr/bin/apt.debian' 'show' 'cowsay'", uid: 1000, path: '/usr/bin:/usr/games', user: 'user' }]);
    expect(shell.uid).toBe(1000);
  });
});
