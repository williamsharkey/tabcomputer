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
import { signoutCmd } from '@shiro/commands/signout';
import { SIGN_OUT_KEY, signOutPlan, signOutText, signOutLines, signOutOfThisComputer, bootSignOut } from '@shiro/sign-out';
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
  shell.commands.register(signoutCmd);
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
  shell.commands.register({ name: 'code', description: 'stand-in', async exec(ctx) { await fs.writeFile('/tmp/code-opened', fs.resolvePath(ctx.args[0] ?? '.', ctx.cwd)); return 0; } });
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
      .toEqual({ config: { name: 'Lab 3', toolchains: ['python', 'c'], run: 'python3 main.py', test: 'python3 -m unittest', notebook: '' }, problems: [] });
    expect(parseLabConfig('{"lab":1}').config).toEqual({ name: '', toolchains: [], run: '', test: '' });
  });

  it('reports every problem by key and gives no config', () => {
    const r = parseLabConfig(JSON.stringify({ lab: 2, toolchain: 'python', toolchains: ['Py thon'], run: 'a\nb', test: 7 }));
    expect(r.config).toBeNull();
    expect(r.problems.join('\n')).toMatch(/unknown key toolchain \(known: lab, name, toolchains, run, test, notebook\)/);
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

describe('Submit and the saved state', () => {
  const dir = `${HOME}/src/work`;
  /** Run a line in the clone, as the Code window's host does */
  const exec = async (line: string) => {
    const sh = shell.fork();
    sh.cwd = dir;
    let out = '';
    const code = await sh.execute(line, (s) => { out += s; }, (s) => { out += s; });
    return { code, out };
  };
  const now = () => new Date('2026-10-12T14:03:00Z');
  let work: FakeGitHub;

  beforeAll(async () => {
    work = fakeGitHub('ann', 'work');
    work.private = true;
    await publish(work, { 'main.py': 'print("hi")\n', 'notes.txt': 'notes\n', [LAB_CONFIG_PATH]: CONFIG });
    globalThis.fetch = work.fetch;
    localStorage.setItem(GITHUB_TOKEN_STORAGE_KEY, TOKEN);
    const r = await run(shell, 'lab open ann/work');
    expect(r.exitCode, r.output).toBe(0);
  });
  beforeEach(() => { globalThis.fetch = work.fetch; localStorage.setItem(GITHUB_TOKEN_STORAGE_KEY, TOKEN); });

  it('a fresh clone is saved; an edit, a new file and a deleted file are not', async () => {
    const s = (await labState(fs, dir))!;
    expect(s).toMatchObject({ root: dir, branch: 'main', remote: 'ann/work', changed: 0, ahead: 0, neverPushed: false, unsaved: false });
    expect(unsavedReason(s)).toBe('');
    await fs.writeFile(`${dir}/main.py`, 'print("hello")\n');
    await fs.writeFile(`${dir}/new.py`, 'x = 1\n');
    await fs.unlink(`${dir}/notes.txt`);
    const t = (await labState(fs, `${dir}/.tabcomputer`))!;
    expect(t).toMatchObject({ root: dir, changed: 3, ahead: 0, unsaved: true });
    expect(unsavedReason(t)).toBe('3 changed files');
    expect(unsavedReason(t, 1)).toBe('1 file with edits not saved, 3 changed files');
    expect((await run(shell, `cd ${dir} && lab status`)).output).toContain(`${UNSAVED_TEXT}: 3 changed files (github.com/ann/work).`);
  });

  it('says why when the tab is not signed in, and keeps the commit', async () => {
    localStorage.removeItem(GITHUB_TOKEN_STORAGE_KEY);
    const r = await submitLab(fs, dir, { run: exec, now });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/^Not submitted\. 3 changed files are committed on this computer only\. /);
    expect(r.text).toMatch(/not signed in to GitHub|GitHub refused this account/);
    const s = (await labState(fs, dir))!;
    expect(s).toMatchObject({ changed: 0, ahead: 1, unsaved: true });
    expect(unsavedReason(s)).toBe('1 commit not pushed');
    expect(work.refs.get('main')!.startsWith(s.head)).toBe(false);
  });

  it('pushes and says what went where', async () => {
    const r = await submitLab(fs, dir, { run: exec, now });
    expect(r.text).toMatch(/^Submitted\. 1 commit went to github\.com\/ann\/work, branch main\. The newest commit there is [0-9a-f]{7}\.$/);
    expect(r.ok).toBe(true);
    const s = (await labState(fs, dir))!;
    expect(s.unsaved).toBe(false);
    expect(work.refs.get('main')!.startsWith(s.head)).toBe(true);
    expect(r.text).not.toContain(TOKEN);
    // What GitHub has now: the edit, the new file, no notes.txt, and the commit's message
    const commit = parseCommit(work.objects.get(work.refs.get('main')!)!.bytes);
    expect(commit.message.trim()).toBe('Submit 2026-10-12 14:03 UTC');
    const names = parseTree(work.objects.get(commit.tree)!.bytes).map((e) => e.path).sort();
    expect(names).toEqual(['.tabcomputer', 'main.py', 'new.py']);
    expect((await submitLab(fs, dir, { run: exec, now })).text).toBe('Nothing to submit. GitHub already has this work (github.com/ann/work, branch main).');
    expect((await run(shell, `cd ${dir} && lab status`)).output).toContain(`${SAVED_TEXT}: github.com/ann/work, branch main`);
  });

  it('says to pull when GitHub has commits this computer does not', async () => {
    // Someone else pushed: the branch on GitHub moves to a commit this clone has never seen
    const other = fakeGitHub('ann', 'other');
    const foreign = await publish(other, { 'teacher.txt': 'feedback\n' });
    for (const [k, v] of other.objects) work.objects.set(k, v);
    const mine = work.refs.get('main')!;
    work.refs.set('main', foreign);
    await fs.writeFile(`${dir}/main.py`, 'print("again, after the teacher")\n');
    const r = await submitLab(fs, dir, { run: exec, now });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/^Not submitted\. 1 changed file is committed on this computer only\. /);
    expect(r.text).toContain('Run "git pull" in the Terminal, then press Submit again.');
    expect(work.refs.get('main')).toBe(foreign);
    work.refs.set('main', mine);
    const again = await submitLab(fs, dir, { run: exec, now });
    expect(again.ok, again.text).toBe(true);
  });

  it('refuses a folder that is no repository, or has no GitHub address', async () => {
    await fs.mkdir('/tmp/plain', { recursive: true });
    expect((await submitLab(fs, '/tmp/plain', { run: exec })).text).toMatch(/^Not submitted\. This folder is not a git repository/);
    await fs.mkdir('/tmp/local', { recursive: true });
    await git.init({ fs: gfs, dir: '/tmp/local', defaultBranch: 'main' });
    await fs.writeFile('/tmp/local/a.txt', 'a\n');
    expect((await submitLab(fs, '/tmp/local', { run: exec })).text).toMatch(/^Not submitted\. This repository has no GitHub address/);
    // Work in a repository with nowhere to push is not "unsaved to GitHub": no mark, no warning
    expect((await labState(fs, '/tmp/local'))!.unsaved).toBe(false);
  });

  it('the Code window: the bar, Run and Test in the Terminal after the saves, Submit, the mark and the warning', async () => {
    const posts: Record<string, any>[] = [];
    const marks: string[] = [];
    const terminal: { cwd: string; command: string; saved: boolean }[] = [];
    let saved = false;
    let why: string | null = null;
    const last = (type: string) => posts.filter((p) => p.type === type).pop()!;
    const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 25)); expect(ok()).toBe(true); };
    document.title = 'tabcomputer';
    const lab = attachLab({
      fs, dir, post: (m) => { posts.push(m); }, setMark: (t) => { marks.push(t); },
      flush: async () => { await new Promise((r) => setTimeout(r, 20)); saved = true; },
      runInTerminal: (cwd, command) => { terminal.push({ cwd, command, saved }); return why; },
      exec: async (cwd, line) => { expect(cwd).toBe(dir); return exec(line); },
    });
    await until(() => !!last('shiro-editor-git'));
    expect(last('shiro-editor-lab')).toMatchObject({ show: true, name: 'Lab 1', run: true, test: true, submit: true, problem: '' });
    expect(last('shiro-editor-git')).toMatchObject({ tracked: true, unsaved: false, text: SAVED_TEXT });
    expect(unsavedWork()).toEqual([]);
    expect((globalThis as any).__tabcomputerUnsavedWork()).toBe(false);

    // Run and Test: the config's commands, in the lab's folder, after the editor's saves landed
    lab.message({ type: 'shiro-editor-action', action: 'run' });
    await until(() => terminal.length === 1);
    expect(terminal[0]).toEqual({ cwd: dir, command: 'echo ran-main', saved: true });
    await until(() => last('shiro-editor-result')?.text === 'Run started in the Terminal: echo ran-main');
    expect(last('shiro-editor-result').ok).toBeNull();
    why = 'The Terminal is still running a command. Stop it with Ctrl+C, then press Test again.';
    lab.message({ type: 'shiro-editor-action', action: 'test' });
    await until(() => terminal.length === 2);
    expect(terminal[1].command).toBe('echo tests-pass');
    await until(() => last('shiro-editor-result').text === why);
    expect(last('shiro-editor-result').ok).toBe(false);

    // An edit that is not saved yet, then a file changed on disk: the mark, the tab's title, the warning
    lab.message({ type: 'shiro-editor-dirty', count: 1 });
    expect(last('shiro-editor-git')).toMatchObject({ unsaved: true, text: UNSAVED_TEXT, detail: '1 file with edits not saved' });
    expect(document.title).toBe('● tabcomputer');
    lab.message({ type: 'shiro-editor-dirty', count: 0 });
    expect(document.title).toBe('tabcomputer');
    await fs.writeFile(`${dir}/main.py`, 'print("from the editor")\n');
    await until(() => last('shiro-editor-git').unsaved === true);
    expect(last('shiro-editor-git').detail).toBe('1 changed file');
    expect(marks[marks.length - 1]).toBe(UNSAVED_TEXT);
    expect(unsavedWork()).toEqual([dir]);
    expect((globalThis as any).__tabcomputerUnsavedWork()).toBe(true);
    expect(document.title).toBe('● tabcomputer');

    // Submit: busy while it runs, the result in words, and the mark clears
    lab.message({ type: 'shiro-editor-action', action: 'submit' });
    await until(() => /^Submitted\./.test(last('shiro-editor-result')?.text ?? ''));
    expect(posts.some((p) => p.type === 'shiro-editor-result' && p.busy === true && p.text === 'Submitting to GitHub…')).toBe(true);
    expect(last('shiro-editor-result')).toMatchObject({ ok: true, busy: false });
    await until(() => last('shiro-editor-git').unsaved === false);
    expect(marks[marks.length - 1]).toBe('');
    expect(document.title).toBe('tabcomputer');
    expect(unsavedWork()).toEqual([]);

    // A config that stops being valid: the buttons go, the problem is said
    await fs.writeFile(`${dir}/${LAB_CONFIG_PATH}`, '{"lab":1,"run":7}');
    await until(() => last('shiro-editor-lab').run === false);
    expect(last('shiro-editor-lab')).toMatchObject({ show: true, submit: false, problem: 'lab.json: run must be text' });
    // (the edit to lab.json is itself work GitHub does not have, until the window closes)
    await until(() => unsavedWork().length === 1);
    lab.dispose();
    expect(unsavedWork()).toEqual([]);
    expect(document.title).toBe('tabcomputer');
  });
});

describe('sign-out for a shared computer', () => {
  const ANTHROPIC = 'sk-ant-' + 'b'.repeat(40);
  const session = new Map<string, string>();
  beforeAll(() => {
    (globalThis as any).sessionStorage = {
      getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => { session.set(k, String(v)); },
      removeItem: (k: string) => { session.delete(k); }, clear: () => session.clear(),
    };
  });

  it('the confirm names the sign-ins, the files and the work GitHub does not have, never a value', async () => {
    localStorage.clear();
    localStorage.setItem(GITHUB_TOKEN_STORAGE_KEY, TOKEN);
    localStorage.setItem('tabcomputer_anthropic_key', ANTHROPIC);
    await fs.mkdir(`${HOME}/.claude`, { recursive: true });
    await fs.writeFile(`${HOME}/.claude/.credentials.json`, JSON.stringify({ claudeAiOauth: { accessToken: ANTHROPIC } }));
    await fs.writeFile(`${HOME}/.netrc`, 'machine example.com login a password b\n');
    // ~/src/work still has the lab.json edit from the test above: uncommitted
    const plan = await signOutPlan(fs, localStorage, HOME);
    expect(plan.signins).toEqual(['The GitHub sign-in', 'The Claude sign-in', 'The Anthropic API key', 'Other saved logins: netrc logins']);
    expect(plan.homeEntries).toBeGreaterThan(2);
    expect(plan.unpushed).toEqual([{ dir: '~/src/work', why: '1 changed file' }]);
    const t = signOutText(plan);
    expect(t.title).toBe('Sign out of this computer?');
    expect(t.deleted[0]).toBe('The GitHub sign-in');
    expect(t.deleted[t.deleted.length - 1]).toMatch(/^Every file in this tab computer: the home folder \(\d+ items\), installed programs and settings$/);
    expect(t.warning).toBe('GitHub does not have this work yet. Signing out deletes it. Submit or push it first.');
    expect(t.lost).toEqual(['~/src/work: 1 changed file']);
    const lines = signOutLines(plan);
    expect(lines).toContain('  - ~/src/work: 1 changed file');
    expect(lines).not.toContain(TOKEN);
    expect(lines).not.toContain(ANTHROPIC);
    // The command says it and deletes nothing without --yes
    const r = await run(shell, 'signout');
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('Nothing was deleted. Run "signout --yes" to do it.');
    expect(localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY)).toBe(TOKEN);
    expect((await run(shell, 'signout --now')).exitCode).toBe(2);
  });

  it('with nothing signed in and nothing unpushed, it says so', () => {
    const t = signOutText({ signins: [], homeEntries: 1, unpushed: [] });
    expect(t.deleted).toEqual(['No sign-in is saved here', 'Every file in this tab computer: the home folder (1 item), installed programs and settings']);
    expect(t.warning).toBe('');
    expect(t.lost).toEqual([]);
  });

  it('removes every sign-in at once and leaves the rest to the next document', async () => {
    localStorage.setItem(`wal:${HOME}/.claude/.credentials.json`, '{"x":1}');
    localStorage.setItem('some-cache', `{"t":"${TOKEN}"}`);
    localStorage.setItem('tabcomputer-desktop-theme', 'dark');
    let went = 0;
    await signOutOfThisComputer(fs, () => { went++; });
    expect(went).toBe(1);
    expect(session.get(SIGN_OUT_KEY)).toBe('1');
    for (const k of [GITHUB_TOKEN_STORAGE_KEY, 'tabcomputer_anthropic_key', `wal:${HOME}/.claude/.credentials.json`, 'some-cache']) expect(localStorage.getItem(k), k).toBeNull();
    expect(localStorage.getItem('tabcomputer-desktop-theme')).toBe('dark');
    expect(await fs.exists(`${HOME}/.claude/.credentials.json`)).toBe(false);
    expect(await fs.exists(`${HOME}/.netrc`)).toBe(false);
    // The work is still there until the next document deletes the profile, and the tab leaves without a warning
    expect(await fs.exists(`${HOME}/src/work/main.py`)).toBe(true);
    expect(unsavedWork()).toEqual([]);
  });

  it('the next document deletes what is left and says so', async () => {
    expect(await bootSignOut()).toBe(true);
    expect(localStorage.getItem('tabcomputer-desktop-theme')).toBeNull();
    expect(session.get(SIGN_OUT_KEY)).toBeUndefined();
    expect(document.title).toBe('Signed out');
    expect(document.getElementById('signed-out')!.textContent).toBe('The sign-ins and every file this tab computer kept in this browser are deleted. You can close this tab.');
    // A load that was not asked to sign out does nothing
    expect(await bootSignOut()).toBe(false);
  });
});
