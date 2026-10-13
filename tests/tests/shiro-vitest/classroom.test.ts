/**
 * The classroom workspace (docs/CLASSROOM.md, tabcomputer#130): the lab link
 * (`?run=lab:owner/repo`), `.tabcomputer/lab.json`, `lab open` against an
 * in-memory GitHub (git-github-api-fake.ts, the private network mode's
 * transport, so nothing leaves the process), Submit and its words, and the
 * "not saved to GitHub yet" state. No real repository is read or pushed to.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import git from '@shiro/commands/git-cached';
import type { FileSystem } from '@shiro/filesystem';
import type { Shell } from '@shiro/shell';
import { parseRunUrl, handleRunLink, originRepo, labFolder, RunLinkError, type RunLinkDeps, type RunPromptInfo } from '@shiro/run-url';
import { LAB_CONFIG_PATH, parseLabConfig, readLabConfig, labState, submitLab, unsavedReason, attachLab, unsavedWork, UNSAVED_TEXT, SAVED_TEXT } from '@shiro/lab';
import { labCmd } from '@shiro/commands/lab';
import { GITHUB_TOKEN_STORAGE_KEY } from '@shiro/credentials';
import { createTestShell, run } from './helpers';
import { fakeGitHub, parseCommit, parseTree, type FakeGitHub } from './git-github-api-fake';

if (!(globalThis as any).localStorage) {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null, get length() { return store.size; },
  };
}

const HOME = '/home/user';
const TOKEN = 'ghp_' + 'a'.repeat(36);
const who = { name: 'Ann Lee', email: 'ann@x.org', timestamp: 1700000000, timezoneOffset: 0 };

let fs: FileSystem;
let shell: Shell;
let gfs: any;
let realFetch: typeof fetch;
let gh: FakeGitHub;
/** What the stand-in `gh auth login` does: sign in (true) or fail */
let signInWorks = true;
let signIns = 0;

/** A repository made here with isomorphic-git, copied object by object to the fake GitHub */
async function publish(target: FakeGitHub, files: Record<string, string>): Promise<string> {
  const dir = `/tmp/class-src-${Math.random().toString(36).slice(2)}`;
  await fs.mkdir(dir, { recursive: true });
  await git.init({ fs: gfs, dir, defaultBranch: 'main' });
  for (const [path, text] of Object.entries(files)) {
    await fs.mkdir(`${dir}/${path}`.replace(/\/[^/]*$/, ''), { recursive: true });
    await fs.writeFile(`${dir}/${path}`, text);
    await git.add({ fs: gfs, dir, filepath: path });
  }
  const tip = await git.commit({ fs: gfs, dir, message: 'Starter code', author: who, committer: who });
  const walk = async (oid: string): Promise<void> => {
    if (target.objects.has(oid)) return;
    const { type, object } = await git.readObject({ fs: gfs, dir, oid, format: 'content' });
    const bytes = Uint8Array.from(object as Uint8Array);
    target.objects.set(oid, { type: type as any, bytes });
    if (type === 'commit') { const c = parseCommit(bytes); await walk(c.tree); for (const p of c.parents) await walk(p); }
    else if (type === 'tree') for (const e of parseTree(bytes)) await walk(e.sha);
  };
  await walk(tip);
  target.refs.set('main', tip);
  return tip;
}

const CONFIG = JSON.stringify({ lab: 1, name: 'Lab 1', run: 'echo ran-main', test: 'echo tests-pass' });

beforeAll(async () => {
  ({ fs, shell } = await createTestShell());
  gfs = fs.toIsomorphicGitFS();
  shell.commands.register(labCmd);
  // `gh auth login` is GitHub's device flow in the page: here it only records that it was asked
  shell.commands.register({
    name: 'gh', description: 'stand-in',
    async exec(ctx) {
      if (ctx.args.join(' ') !== 'auth login') return 1;
      signIns++;
      if (!signInWorks) { ctx.stderr += 'gh: sign-in cancelled\n'; return 1; }
      localStorage.setItem(GITHUB_TOKEN_STORAGE_KEY, TOKEN);
      return 0;
    },
  });
  // `code` opens a window on the desktop: here it records the folder
  shell.commands.register({ name: 'code', description: 'stand-in', async exec(ctx) { await fs.writeFile('/tmp/code-opened', ctx.args.join(' ')); return 0; } });
  shell.env['TABCOMPUTER_NETWORK_MODE'] = 'private';
  shell.env['HOME'] = HOME;
  await fs.mkdir(HOME, { recursive: true });
  await fs.writeFile(`${HOME}/.gitconfig`, '[user]\n\tname = Ann Lee\n\temail = ann@x.org\n');
  realFetch = globalThis.fetch;
});
afterAll(() => { globalThis.fetch = realFetch; localStorage.removeItem(GITHUB_TOKEN_STORAGE_KEY); });
beforeEach(() => { localStorage.removeItem(GITHUB_TOKEN_STORAGE_KEY); signInWorks = true; signIns = 0; });

describe('the lab: form of a run link', () => {
  it('parses lab:owner/repo and nothing longer', () => {
    expect(parseRunUrl('?run=lab:cs-101/lab1-ann')!.target).toEqual({ kind: 'lab', name: 'lab-cs-101-lab1-ann', owner: 'cs-101', repo: 'lab1-ann' });
    for (const bad of ['lab:', 'lab:ann', 'lab:ann/', 'lab:ann/proj/extra', 'lab:ann/.github', 'lab:ann/proj.git', 'lab:-ann/proj', 'lab:ann/pr oj', 'lab:ann/$(id)', 'lab:../x']) {
      expect(() => parseRunUrl('?run=' + encodeURIComponent(bad)), bad).toThrow(RunLinkError);
    }
    // A recipe may not take the name of a lab link's form
    expect(() => parseRunUrl('?run=lab-x')).toThrow(RunLinkError);
  });

  it('reads whose repository a clone is from its origin', () => {
    expect(originRepo('[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/Ann/Proj.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n')).toBe('ann/proj');
    expect(originRepo('[remote "origin"]\n\turl = git@github.com:ann/proj\n')).toBe('ann/proj');
    expect(originRepo('[remote "upstream"]\n\turl = https://github.com/ann/proj\n')).toBe('');
    expect(originRepo('[remote "origin"]\n\turl = https://example.com/ann/proj\n')).toBe('');
    expect(originRepo('[remote "origin"]\n\turl = https://github.com.evil.example/ann/proj\n')).toBe('');
  });

  const deps = (search: string, over: Partial<RunLinkDeps> = {}) => {
    const seen = { prompts: [] as RunPromptInfo[], terminals: [] as { cwd: string; command: string }[], reports: [] as string[], fetched: [] as string[], cleaned: 0 };
    const d: RunLinkDeps = {
      search, origin: 'https://tabcomputer.com', home: HOME, framed: false,
      fetch: async (url) => { seen.fetched.push(String(url)); return new Response('', { status: 404 }); },
      fs, cleanUrl: () => { seen.cleaned++; },
      confirm: async (info) => { seen.prompts.push(info); return true; },
      openTerminal: (o) => { seen.terminals.push({ cwd: o.cwd, command: o.command }); },
      report: (m) => { seen.reports.push(m); },
      ...over,
    };
    return { d, seen };
  };

  it('asks before the first clone, and fetches nothing itself', async () => {
    const { d, seen } = deps('?run=lab:ann/fresh&ui=desktop');
    expect(await handleRunLink(d)).toBe('ran');
    expect(seen.cleaned).toBe(1);
    expect(seen.fetched).toEqual([]);
    expect(seen.prompts).toHaveLength(1);
    const p = seen.prompts[0];
    expect(p.from).toBe('github.com/ann/fresh');
    expect(p.wording!.title).toBe('Open ann/fresh?');
    expect(p.wording!.action).toBe('Open');
    expect(p.script).toContain('git clone https://github.com/ann/fresh ~/src/fresh');
    expect(seen.terminals).toEqual([{ cwd: HOME, command: 'lab open ann/fresh' }]);
  });

  it('Cancel opens nothing; a framed page is refused; arguments are ignored and named', async () => {
    const a = deps('?run=lab:ann/fresh', { confirm: async () => false });
    expect(await handleRunLink(a.d)).toBe('cancelled');
    expect(a.seen.terminals).toEqual([]);
    const b = deps('?run=lab:ann/fresh', { framed: true });
    expect(await handleRunLink(b.d)).toBe('refused');
    expect(b.seen.prompts).toEqual([]);
    expect(b.seen.terminals).toEqual([]);
    const c = deps('?run=lab:ann/fresh&path=/etc');
    await handleRunLink(c.d);
    expect(c.seen.reports.join()).toContain('ignored path');
    expect(c.seen.terminals[0].command).toBe('lab open ann/fresh');
  });

  it('does not ask again for a folder that is already a clone of that repository', async () => {
    await fs.mkdir(`${HOME}/src/done/.git`, { recursive: true });
    await fs.writeFile(`${HOME}/src/done/.git/config`, '[remote "origin"]\n\turl = https://github.com/ann/done\n');
    const { d, seen } = deps('?run=lab:ann/done');
    expect(await handleRunLink(d)).toBe('on-open');
    expect(seen.prompts).toEqual([]);
    expect(seen.terminals).toEqual([{ cwd: HOME, command: 'lab open ann/done' }]);
    // Another owner's repository of the same name is another folder, and is asked about
    expect(await labFolder(fs, HOME, 'eve', 'done')).toEqual({ dir: `${HOME}/src/eve/done`, cloned: false });
    const other = deps('?run=lab:eve/done');
    await handleRunLink(other.d);
    expect(other.seen.prompts).toHaveLength(1);
    expect(other.seen.prompts[0].script).toContain('~/src/eve/done');
  });
});

describe('.tabcomputer/lab.json', () => {
  it('reads the toolchains and the two commands', () => {
    expect(parseLabConfig('{"lab":1,"name":"Lab 3","toolchains":["python","c","c"],"run":" python3 main.py ","test":"python3 -m unittest"}'))
      .toEqual({ config: { name: 'Lab 3', toolchains: ['python', 'c'], run: 'python3 main.py', test: 'python3 -m unittest' }, problems: [] });
    expect(parseLabConfig('{"lab":1}').config).toEqual({ name: '', toolchains: [], run: '', test: '' });
  });

  it('reports every problem by key and gives no config', () => {
    const r = parseLabConfig(JSON.stringify({ lab: 2, toolchain: 'python', toolchains: ['Py thon'], run: 'a\nb', test: 7 }));
    expect(r.config).toBeNull();
    expect(r.problems.join('\n')).toMatch(/unknown key toolchain \(known: lab, name, toolchains, run, test\)/);
    expect(r.problems.join('\n')).toMatch(/lab is 2: this build reads format 1/);
    expect(r.problems.join('\n')).toMatch(/toolchains has a name that is not a toolchain id/);
    expect(r.problems.join('\n')).toMatch(/run must be one line/);
    expect(r.problems.join('\n')).toMatch(/test must be text/);
    expect(parseLabConfig('nope').problems).toEqual(['lab.json: it is not JSON']);
    expect(parseLabConfig('[]').config).toBeNull();
    expect(parseLabConfig(JSON.stringify({ lab: 1, run: 'x' + String.fromCharCode(0x202e) + 'y' })).config).toBeNull();
  });
});

describe('lab open', () => {
  it('clones a public repository without a sign-in and opens the Code app on it', async () => {
    gh = fakeGitHub('ann', 'pub');
    await publish(gh, { 'main.py': 'print("hi")\n', [LAB_CONFIG_PATH]: CONFIG });
    globalThis.fetch = gh.fetch;
    const r = await run(shell, 'lab open ann/pub');
    expect(r.exitCode, r.output).toBe(0);
    expect(signIns).toBe(0);
    expect(await fs.readFile(`${HOME}/src/pub/main.py`, 'utf8')).toBe('print("hi")\n');
    expect(await fs.readFile('/tmp/code-opened', 'utf8')).toBe(`${HOME}/src/pub`);
    expect(shell.cwd).toBe(`${HOME}/src/pub`);
    expect(r.output).toContain('ann/pub is open in ~/src/pub. Run, Test and Submit are at the top of the Code app.');
    expect((await readLabConfig(fs, `${HOME}/src/pub`))!.config!.run).toBe('echo ran-main');
    // The second time nothing is cloned
    const before = gh.calls.length;
    await run(shell, 'cd /');
    expect((await run(shell, 'lab open ann/pub')).exitCode).toBe(0);
    expect(gh.calls.length).toBe(before);
    expect(shell.cwd).toBe(`${HOME}/src/pub`);
  });

  it('signs in for a private repository, then clones it', async () => {
    gh = fakeGitHub('ann', 'secret');
    gh.private = true;
    await publish(gh, { 'main.c': 'int main(void){return 0;}\n', [LAB_CONFIG_PATH]: CONFIG });
    globalThis.fetch = gh.fetch;
    const r = await run(shell, 'lab open ann/secret');
    expect(r.exitCode, r.output).toBe(0);
    expect(signIns).toBe(1);
    expect(r.output).toContain('the repository is private, or the name is wrong');
    expect(await fs.exists(`${HOME}/src/secret/main.c`)).toBe(true);
    expect(r.output).not.toContain(TOKEN);
  });

  it('leaves no folder behind when the sign-in is cancelled or the account has no access', async () => {
    gh = fakeGitHub('ann', 'closed');
    gh.private = true;
    await publish(gh, { 'a.txt': 'a\n' });
    globalThis.fetch = gh.fetch;
    signInWorks = false;
    const r = await run(shell, 'lab open ann/closed');
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('not signed in to GitHub, so ann/closed was not opened');
    expect(await fs.exists(`${HOME}/src/closed`)).toBe(false);
    // Signed in, but the repository is not there for this account
    localStorage.setItem(GITHUB_TOKEN_STORAGE_KEY, TOKEN);
    const r2 = await run(shell, 'lab open ann/nothere');
    expect(r2.exitCode).toBe(1);
    expect(r2.output).toContain('GitHub did not let this account copy ann/nothere');
    expect(await fs.exists(`${HOME}/src/nothere`)).toBe(false);
  });

  it('refuses a name that is not OWNER/REPO', async () => {
    for (const bad of ['ann', 'ann/.ssh', "'ann/x;id'", 'https://example.com/ann/x']) {
      expect((await run(shell, `lab open ${bad}`)).exitCode, bad).toBe(2);
    }
  });
});
