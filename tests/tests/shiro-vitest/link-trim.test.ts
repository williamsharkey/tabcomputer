/**
 * `link`: a script from what was typed (src/link-trim.ts, src/session-log.ts,
 * src/net-tally.ts, docs/RUN_LINKS.md "link", tabcomputer#147).
 *
 * The rules under test: a line stays when it succeeded and changed
 * something; failures, looking around, repeats and `link` itself go; `cd` is
 * folded into the lines that follow; an editor's file is its present
 * contents, or is named as not in the link.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { SESSIONS, HOME } from './fixtures/link-sessions';
import { FILE_TEXT_MAX, editedPaths, editorFiles, lineKind, scriptPath, secretIn, simpleCommands, trimSession, type TrimEntry } from '@shiro/link-trim';
import { NOISE, noteEdited, resetSessionLog, sessionEnd, sessionLog, sessionStart, watchSessionFs } from '@shiro/session-log';
import { RELAY_WARN_BYTES, classifyUrl, downloadSentences, received, sumTally, tallySince } from '@shiro/net-tally';
import { parseFragment, scriptLink } from '@shiro/link-fragment';
import { buildLink, fileNow, linkCmd } from '@shiro/commands/link';
import { handleRunLink, type RunLinkDeps } from '@shiro/run-url';

const ORIGIN = 'https://tabcomputer.com';
/** The origin the link command sees in this test's page */
const SITE = typeof location !== 'undefined' && /^https?:$/.test(location.protocol) ? `${location.protocol}//${location.host}` : ORIGIN;

describe('link: six recorded sessions', () => {
  const report: string[] = [];
  for (const s of SESSIONS) {
    it(`${s.name}: the script, and what was dropped`, async () => {
      const t = trimSession({ entries: s.entries, edits: s.edits, home: HOME, cwd: s.cwd, files: s.files });
      expect(t.script).toBe(s.script);
      // every line of the session is accounted for once: kept, or dropped with a reason
      const typed = s.entries.map((e) => e.line);
      expect([...t.kept.map((k) => k.line), ...t.dropped.map((d) => d.line)].sort()).toEqual([...typed].sort());
      for (const d of t.dropped) expect(d.why, d.line).toBeTruthy();
      expect(t.dropped.some((d) => d.line === 'link' && d.why === 'the link command itself')).toBe(true);
      for (const re of s.notInLink ?? []) expect(t.notInLink.some((n) => re.test(n)), String(re)).toBe(true);
      expect(t.notInLink).toHaveLength((s.notInLink ?? []).length);
      for (const x of s.extra) expect(t.kept.some((k) => k.line === x), x).toBe(true);
      // the link for it: its form and its length, and that the app reads the same script back
      const link = await scriptLink(t.script, ORIGIN);
      const back = parseFragment(new URL(link.url).hash)!;
      if (back.kind === 'commands') expect(back.text).toBe(t.script);
      report.push(`${s.name}: ${typed.length} lines typed, ${t.kept.length} kept, ${t.dropped.length} dropped, ${t.files.length} ${t.files.length === 1 ? 'file' : 'files'} as here-documents, ${s.extra.length} kept that should have gone; `
        + `script ${t.script.split('\n').length - 1} lines; link ${link.form} ${link.url.length} characters (readable ${link.readable}, compressed ${link.compressed})`);
    });
  }
  it('prints the count for each session', () => {
    console.log('[link] the six sessions:\n  ' + report.join('\n  '));
    expect(report).toHaveLength(6);
  });

  it('says why each line of the mistakes went', () => {
    const s = SESSIONS.find((x) => x.name === 'a session full of mistakes')!;
    const t = trimSession({ entries: s.entries, home: HOME, cwd: s.cwd, files: s.files });
    const why = Object.fromEntries(t.dropped.map((d) => [d.line, d.why]));
    expect(why).toMatchObject({
      'pyhton3 --version': 'no such command (status 127)',
      'python3 --version': 'looking around',
      'pip install reqeusts': 'it failed (status 1)',
      'cd ..': 'a change of folder: each kept line is given its folder',
      'cd porj': 'it failed (status 1)',
      'python3 main.py': 'it changed nothing',
      'git comit -m first': 'it failed (status 1)',
      'history': 'looking around',
      'clear': 'looking around',
      // made and then removed: together they changed nothing
      'touch main.py': 'undone later (rm main.py)',
      'rm main.py': 'it only undid an earlier line (touch main.py)',
    });
    // `pip install requests` twice: an install is kept by its name, and one of the two stays
    expect(t.dropped.filter((d) => d.line === 'pip install requests').map((d) => d.why)).toEqual(['entered again later']);
    expect(Object.fromEntries(t.kept.map((k) => [k.line, k.why]))).toMatchObject({ 'pip install requests': 'installed something', 'git init': 'changed files', 'mkdir proj && cd proj': 'changed files' });
  });
});

describe('link: the rules, one at a time', () => {
  let t = 1000;
  const e = (line: string, cwd: string, status: number | null, o: Partial<TrimEntry> = {}): TrimEntry => {
    t += 2000;
    return { line, cwd, cwdAfter: o.cwdAfter ?? cwd, status, at: t, end: status === null ? 0 : t + (o.end ?? 200), changed: o.changed ?? [], more: o.more ?? 0 };
  };
  const trim = (entries: TrimEntry[], o: { cwd?: string; files?: [string, Parameters<typeof trimSession>[0]['files'] extends Map<string, infer V> ? V : never][]; edits?: { path: string; at: number }[]; linked?: [string, string][] } = {}) =>
    trimSession({ entries, home: HOME, cwd: o.cwd ?? HOME, files: new Map(o.files ?? []), edits: o.edits, linked: o.linked ? new Map(o.linked) : undefined });
  beforeEach(() => { t = 1000; });

  it('what kind of line a line is', () => {
    const kinds: [string, string][] = [
      ['ls -la', 'look'], ['cat a.txt', 'look'], ['pwd', 'look'], ['git status', 'look'], ['git log --oneline | head', 'look'], ['man ls', 'look'], ['make --help', 'look'], ['node --version', 'look'],
      ['history | grep pip', 'look'], ['clear', 'look'], ['echo hi', 'look'], ['env', 'look'], ['git branch', 'look'], ['git remote -v', 'look'], ['npm ls', 'look'], ['pip list', 'look'], ['find . -name "*.c"', 'look'],
      ['# just a note', 'look'], ['', 'look'],
      ['cd src', 'cd'], ['cd a && ls && cd ..', 'cd'], ['pushd /tmp', 'cd'],
      ['vim a.c', 'editor'], ['nano notes.txt', 'editor'], ['code .', 'editor'], ['sudo vim /etc/hosts', 'editor'],
      ['claude', 'inside'], ['python3', 'inside'], ['node', 'inside'], ['psql', 'inside'], ['ssh host', 'inside'],
      ['export PATH=$PATH:~/bin', 'state'], ['alias ll="ls -l"', 'state'], ['FOO=1', 'state'], ['source venv/bin/activate', 'state'], ['. ./env.sh', 'state'],
      ['link', 'link'], ['link --print', 'link'],
      ['cat a b > c', 'command'], ['echo hi >> log.txt', 'command'], ['ls | tee files.txt', 'command'], ['find . -name "*.o" -delete', 'command'], ['git branch feature', 'command'],
      ['git commit -m "a; b && c"', 'command'], ['python3 app.py', 'command'], ['python3 -c "print(1)"', 'command'], ['python3 -m venv venv', 'command'], ['FOO=1 make', 'command'], ['sudo apt install -y jq', 'command'],
      ['cd proj && make', 'command'], ['curl -sL https://x.sh | sh', 'command'], ['npm run dev', 'command'], ['echo hi 2>&1', 'look'], ['ls > /dev/null', 'look'], ['make 2>&1 | tail', 'command'],
      ['cat > app.py <<\'EOF\'\nprint("x; y")\nEOF', 'command'],
    ];
    for (const [line, kind] of kinds) expect(lineKind(line), line).toBe(kind);
    expect(simpleCommands('a "b c" && d \'e;f\' | g > out.txt; h 2>&1').map((c) => [c.words.join(' '), c.redirects])).toEqual([['a b c', false], ['d e;f', false], ['g', true], ['h', false]]);
  });

  it('keeps what succeeded and changed something; drops failures, looking and what changed nothing', () => {
    const r = trim([
      e('npm install', HOME, 0, { changed: [`${HOME}/node_modules`], more: 900 }),
      e('npm test', HOME, 1),
      e('node check.js', HOME, 0),
      e('ls', HOME, 0),
      e('export NODE_ENV=production', HOME, 0),
    ]);
    expect(r.script).toBe('npm install\nexport NODE_ENV=production\n');
    expect(r.dropped.map((d) => d.why)).toEqual(['it failed (status 1)', 'it changed nothing', 'looking around']);
    expect(trim([]).script).toBe('');
    expect(trim([e('ls', HOME, 0), e('link', HOME, null)]).script).toBe('');
  });

  it('a line entered again later, word for word, in the same folder: the last one stays', () => {
    const r = trim([
      e('make', `${HOME}/a`, 0, { changed: [`${HOME}/a/x.o`] }),
      e('touch stamp', `${HOME}/a`, 0, { changed: [`${HOME}/a/stamp`] }),
      e('make', `${HOME}/a`, 0, { changed: [`${HOME}/a/x.o`] }),
      e('make', `${HOME}/b`, 0, { changed: [`${HOME}/b/y.o`] }),
    ], { cwd: `${HOME}/b` });
    expect(r.script).toBe('cd ~/a\ntouch stamp\nmake\ncd ~/b\nmake\n');
    expect(r.dropped).toEqual([{ line: 'make', why: 'entered again later' }]);
  });

  it('two lines that cancel out are both left out: a file, a folder, an install and its uninstall', () => {
    const made = (path: string) => ({ changed: [`${HOME}/${path}`] });
    const r = trim([
      e('touch notes.txt', HOME, 0, made('notes.txt')),
      e('rm notes.txt', HOME, 0, made('notes.txt')),
      e('mkdir scratch', HOME, 0, made('scratch')),
      e('rmdir scratch', HOME, 0, made('scratch')),
      e('pip install requests', HOME, 0, { changed: [`${HOME}/.local/lib/python3.13/site-packages/requests/__init__.py`], more: 60 }),
      e('pip3 uninstall -y requests', HOME, 0, { changed: [`${HOME}/.local/lib/python3.13/site-packages/requests/__init__.py`], more: 60 }),
      e('echo keep > kept.txt', HOME, 0, made('kept.txt')),
    ]);
    expect(r.script).toBe('echo keep > kept.txt\n');
    expect(Object.fromEntries(r.dropped.map((d) => [d.line, d.why]))).toEqual({
      'touch notes.txt': 'undone later (rm notes.txt)', 'rm notes.txt': 'it only undid an earlier line (touch notes.txt)',
      'mkdir scratch': 'undone later (rmdir scratch)', 'rmdir scratch': 'it only undid an earlier line (mkdir scratch)',
      'pip install requests': 'undone later (pip3 uninstall -y requests)', 'pip3 uninstall -y requests': 'it only undid an earlier line (pip install requests)',
    });
    // the same thing by other words: a path from another folder, rm -r of a folder, npm in the same project
    expect(trim([
      e('mkdir -p build', `${HOME}/p`, 0, made('p/build')), e('rm -rf ~/p/build', HOME, 0, made('p/build')),
      e('npm install left-pad', `${HOME}/p`, 0, made('p/node_modules/left-pad/index.js')), e('npm uninstall left-pad', `${HOME}/p`, 0, made('p/node_modules/left-pad/index.js')),
      e('app install expenses', HOME, 0), e('app remove expenses', HOME, 0),
    ]).script).toBe('');

    // what does not cancel: both lines stay
    const stays = (entries: TrimEntry[], cwd = HOME) => trim(entries, { cwd }).kept.map((k) => k.line);
    // something in between used it
    expect(stays([e('touch main.py', HOME, 0, made('main.py')), e('python3 main.py > out.txt', HOME, 0, made('out.txt')), e('rm main.py', HOME, 0, made('main.py'))])).toEqual(['touch main.py', 'python3 main.py > out.txt', 'rm main.py']);
    expect(stays([e('mkdir tmp1', HOME, 0, made('tmp1')), e('make', `${HOME}/tmp1`, 0, made('out.bin')), e('rmdir tmp1', HOME, 0, made('tmp1'))])).toEqual(['mkdir tmp1', 'make', 'rmdir tmp1']);
    expect(stays([e('pip install flask', HOME, 0), e('flask --app x routes > routes.txt', HOME, 0, made('routes.txt')), e('pip uninstall -y flask', HOME, 0)])).toHaveLength(3);
    // not the same thing: another file, another package, another project, a global install
    expect(stays([e('touch a.txt', HOME, 0, made('a.txt')), e('rm b.txt', HOME, 0, made('b.txt'))])).toHaveLength(2);
    expect(stays([e('pip install flask', HOME, 0), e('pip uninstall -y requests', HOME, 0, made('x'))])).toHaveLength(2);
    expect(stays([e('npm install left-pad', `${HOME}/a`, 0, made('a/node_modules/x')), e('npm uninstall left-pad', `${HOME}/b`, 0, made('b/node_modules/x'))], `${HOME}/b`)).toHaveLength(2);
    expect(stays([e('npm install -g left-pad', `${HOME}/a`, 0, made('x')), e('npm uninstall left-pad', `${HOME}/a`, 0, made('a/node_modules/x'))], `${HOME}/a`)).toHaveLength(2);
    // a line that did more than make the one thing (it changed two files), or that is more than one command
    expect(stays([e('cp -r src copy', HOME, 0, { changed: [`${HOME}/copy`, `${HOME}/copy/a`] }), e('rm -r copy', HOME, 0, made('copy'))])).toHaveLength(2);
    expect(stays([e('touch a.txt && echo done', HOME, 0, made('a.txt')), e('rm a.txt', HOME, 0, made('a.txt'))])).toHaveLength(2);
    // a file that was there before: removing it is a change of its own
    expect(stays([e('rm old.txt', HOME, 0, made('old.txt'))])).toEqual(['rm old.txt']);
    // made, removed, and made again: the first two go, the last stays
    expect(trim([e('touch main.py', HOME, 0, made('main.py')), e('rm main.py', HOME, 0, made('main.py')), e('echo x > main.py', HOME, 0, made('main.py'))]).script).toBe('echo x > main.py\n');
  });

  it('a file that came from the person\'s computer is named under "not in the link"', () => {
    const r = trimSession({
      entries: [e('upload', HOME, 0, { changed: [`${HOME}/data.csv`] }), e('wc -l data.csv > count.txt', HOME, 0, { changed: [`${HOME}/count.txt`] })],
      home: HOME, cwd: HOME, files: new Map(), arrived: [{ path: `${HOME}/data.csv`, size: 12_400 }, { path: `${HOME}/my photos/cat.png`, size: 2_300_000 }],
    });
    expect(r.script).toBe('wc -l data.csv > count.txt\n');
    expect(r.dropped).toEqual([{ line: 'upload', why: 'files chosen from this computer: a link cannot carry them' }]);
    expect(r.notInLink).toEqual([
      '~/data.csv (13 KB, from your computer) is not in the link. Put it where the link\'s commands can fetch it, and add the line that fetches it.',
      '~/\'my photos/cat.png\' (2.3 MB, from your computer) is not in the link. Put it where the link\'s commands can fetch it, and add the line that fetches it.',
    ]);
  });

  it('cd is folded into the lines that follow, and a cd that nets out leaves nothing', () => {
    const r = trim([
      e('cd /opt', HOME, 0, { cwdAfter: '/opt' }),
      e('ls', '/opt', 0),
      e('cd', '/opt', 0, { cwdAfter: HOME }),
      e('mkdir "my project"', HOME, 0, { changed: [`${HOME}/my project`] }),
      e('cd my\\ project', HOME, 0, { cwdAfter: `${HOME}/my project` }),
      e('git init', `${HOME}/my project`, 0, { changed: [`${HOME}/my project/.git`] }),
      e('cd ..', `${HOME}/my project`, 0, { cwdAfter: HOME }),
    ]);
    expect(r.script).toBe('mkdir "my project"\ncd ~/\'my project\'\ngit init\ncd ~\n');
    // where the shell is now is where the script ends
    expect(trim([e('cd /opt', HOME, 0, { cwdAfter: '/opt' })], { cwd: '/opt' }).script).toBe('cd /opt\n');
    expect(scriptPath(`${HOME}/a b/it's`, HOME)).toBe(`~/'a b/it'\\''s'`);
    expect(scriptPath('/etc/hosts', HOME)).toBe('/etc/hosts');
  });

  it('an editor\'s file is what it holds now, once, where it was first edited', () => {
    const f = `${HOME}/p/notes.md`;
    const entries = [
      e('mkdir p', HOME, 0, { changed: [`${HOME}/p`] }),
      e('nano p/notes.md', HOME, 0, { changed: [f] }),
      e('touch p/done', HOME, 0, { changed: [`${HOME}/p/done`] }),
      e('nano p/notes.md', HOME, 0, { changed: [f] }),
      e('vim /etc/motd', HOME, 0, { changed: ['/etc/motd'] }),
      e('nano p/sub/deep.txt', HOME, 0, { changed: [`${HOME}/p/sub/deep.txt`] }),
      e('vim gone.txt', HOME, 0, { changed: [`${HOME}/gone.txt`] }),
      e('nano broken.txt', HOME, 1, { changed: [`${HOME}/broken.txt`] }),
    ];
    expect(editedPaths({ entries, edits: [{ path: `${HOME}/x.css`, at: 1 }] }).sort()).toEqual(['/etc/motd', `${HOME}/gone.txt`, f, `${HOME}/p/sub/deep.txt`, `${HOME}/x.css`].sort());
    const r = trim(entries, { files: [[f, { text: 'final\ntext\n' }], ['/etc/motd', { text: 'EOF\nhello' }], [`${HOME}/p/sub/deep.txt`, { text: '' }], [`${HOME}/gone.txt`, { missing: true }]] });
    expect(r.script).toBe([
      'mkdir p',
      'cat > p/notes.md <<\'EOF\'', 'final', 'text', 'EOF',
      'touch p/done',
      // a line of the file is EOF: another mark; no line break at its end: the here-document adds one
      'cat > /etc/motd <<\'EOF_2\'', 'EOF', 'hello', 'EOF_2',
      'mkdir -p p/sub',
      'cat > p/sub/deep.txt <<\'EOF\'', 'EOF',
      '',
    ].join('\n'));
    expect(r.files).toEqual([f, '/etc/motd', `${HOME}/p/sub/deep.txt`]);
    expect(r.dropped.filter((d) => /^(nano|vim)/.test(d.line)).map((d) => d.why)).toEqual([
      'an editor: the files it wrote are recorded as they are now', 'an editor: the files it wrote are recorded as they are now', 'an editor: the files it wrote are recorded as they are now',
      'an editor: the files it wrote are recorded as they are now', 'an editor: the files it wrote are recorded as they are now', 'it failed (status 1)',
    ]);
  });

  it('an editor\'s files are the ones it was started on, not what something else wrote meanwhile', () => {
    // (found in the browser: boot's package preinstall wrote /var/lib/pkg/status.json while vi was open)
    const vi = e('vi notes.txt', `${HOME}/site`, 0, { changed: ['/var/lib/pkg/status.json', `${HOME}/site/notes.txt`, `${HOME}/other/download.bin`] });
    expect(editorFiles(vi)).toEqual([`${HOME}/site/notes.txt`]);
    expect(editorFiles(e('code .', `${HOME}/site`, 0, { changed: [`${HOME}/site/a/b.css`, '/usr/local/bin/claude', `${HOME}/sitemap.txt`] }))).toEqual([`${HOME}/site/a/b.css`]);
    expect(editorFiles(e('vim', `${HOME}/site`, 0, { changed: [`${HOME}/site/new.txt`, '/var/lib/pkg/status.json'] }))).toEqual([`${HOME}/site/new.txt`]);
    expect(editorFiles(e('sudo vim +12 ../conf/x.ini /etc/hosts', `${HOME}/site`, 0, { changed: ['/etc/hosts', `${HOME}/conf/x.ini`, '/etc/hostname'] }))).toEqual(['/etc/hosts', `${HOME}/conf/x.ini`]);
    expect(editorFiles(e('nano ~/site/notes.txt', '/tmp', 0, { changed: [`${HOME}/site/notes.txt`, '/tmp/x'] }))).toEqual([`${HOME}/site/notes.txt`]);
    const r = trim([vi], { cwd: `${HOME}/site`, files: [[`${HOME}/site/notes.txt`, { text: 'n\n' }], ['/var/lib/pkg/status.json', { text: '{}' }]] });
    expect(r.script).toBe('cd ~/site\ncat > notes.txt <<\'EOF\'\nn\nEOF\n');
    // an install is kept by its name, also when nothing it wrote was recorded
    expect(trim([e('pkg install jq', HOME, 0), e('python3 main.py', HOME, 0)]).script).toBe('pkg install jq\n');
  });

  it('a line that may hold a secret is left out, and the link says so', () => {
    const secrets: [string, string][] = [
      ['export OPENAI_API_KEY=abc123', 'OPENAI_API_KEY'], ['GITHUB_TOKEN=x gh repo list > repos.txt', 'GITHUB_TOKEN'], ['export DB_PASSWORD="hunter two"', 'DB_PASSWORD'],
      ['curl -H "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123" https://api.github.com/user -o me.json', 'a token'], ['npm config set //registry.npmjs.org/:_authToken=abcdef', '_authToken'],
      ['mysql --password=s3cret -e "create database x"', 'password'], ['tool login --token abc123', 'token'], ['echo sk-abcdefghijklmnopqrstuvwxyz > key.txt', 'a token'],
    ];
    for (const [line, name] of secrets) expect(secretIn(line), line).toBe(name);
    // a name alone gives nothing away
    for (const line of ['export PATH=$PATH:~/bin', 'export API_KEY=$OTHER_KEY', 'tool login --token "$TOKEN"', 'export NODE_ENV=production', 'git clone https://github.com/a/b', 'ssh-keygen -t ed25519', 'tool --password']) expect(secretIn(line), line).toBe('');
    const r = trim([
      e('export OPENAI_API_KEY=abc123', HOME, 0),
      e('export NODE_ENV=production', HOME, 0),
      e('GITHUB_TOKEN=x gh repo list > repos.txt', HOME, 0, { changed: [`${HOME}/repos.txt`] }),
    ]);
    expect(r.script).toBe('export NODE_ENV=production\n');
    expect(r.dropped).toEqual([{ line: 'export OPENAI_API_KEY=abc123', why: 'it may hold a secret (OPENAI_API_KEY)' }, { line: 'GITHUB_TOKEN=x gh repo list > repos.txt', why: 'it may hold a secret (GITHUB_TOKEN)' }]);
    expect(r.notInLink[0]).toBe('A line that sets OPENAI_API_KEY was left out: it may hold a secret, and a link is for other people. Add it by hand if it holds none.');
  });

  it('work inside a program is not in the link, and the link says so', () => {
    const r = trim([e('claude', HOME, 0, { changed: [`${HOME}/a.py`, `${HOME}/b.py`], more: 3 }), e('python3', HOME, 0)]);
    expect(r.script).toBe('');
    expect(r.notInLink).toEqual(['What was done inside claude is not in the link: it changed 5 files.']);
  });

  it('a program that runs: the last one, at the end; one stopped at once is a failure', () => {
    const r = trim([
      e('python3 -m http.server', HOME, 130, { end: 30_000 }),
      e('npm run dev', HOME, 130, { end: 500 }),
      e('touch a', HOME, 0, { changed: [`${HOME}/a`] }),
      e('node server.js', `${HOME}/srv`, null),
      e('touch b', HOME, 0, { changed: [`${HOME}/b`] }),
    ]);
    expect(r.script).toBe('touch a\ntouch b\ncd ~/srv\nnode server.js\n');
    expect(r.dropped).toEqual([{ line: 'npm run dev', why: 'it was stopped with Ctrl-C' }, { line: 'python3 -m http.server', why: 'a program that was run again later' }]);
    expect(r.kept[r.kept.length - 1]).toEqual({ line: 'node server.js', why: 'the program that is running' });
  });

  it('a tab that was opened with a link: its commands are in the new link, not the line that sourced them', () => {
    const src = '. ~/run/sh-0123456789ab/.run-link';
    const r = trim([e(src, HOME, 0, { cwdAfter: `${HOME}/site`, changed: [`${HOME}/site`] }), e('touch more', `${HOME}/site`, 0, { changed: [`${HOME}/site/more`] })],
      { cwd: `${HOME}/site`, linked: [['sh-0123456789ab', 'mkdir site\ncd site\n']] });
    expect(r.script).toBe('mkdir site\ncd site\ntouch more\n');
    const other = trim([e('. ~/run/c-class/.run-link', `${HOME}/run/c-class`, 0)]);
    expect(other.script).toBe('');
    expect(other.notInLink[0]).toMatch(/began with a run link \(c-class\)/);
  });
});

describe('link: what the session log records', () => {
  it('each line with its folders, its status and the files that changed while it ran', async () => {
    const { fs, shell } = await createTestShell();
    resetSessionLog();
    const stop = watchSessionFs(fs);
    await fs.rm(`${HOME}/rec`, { recursive: true }).catch(() => {});
    shell.cwd = HOME;
    // (the terminal's runLine does exactly this around each line: src/terminal.ts)
    const typed = async (line: string) => {
      const rec = sessionStart(line, shell.cwd);
      const r = await run(shell, line);
      sessionEnd(rec, r.exitCode, shell.cwd);
      return r;
    };
    await typed('mkdir rec && cd rec');
    await typed('echo one > a.txt');
    await typed('ls');
    await typed('cat nothing-here');
    await typed('cd ..');
    // between lines: a change that belongs to no line
    await fs.writeFile(`${HOME}/rec/loose.txt`, 'x');
    noteEdited(`${HOME}/rec/a.txt`);
    noteEdited(`${HOME}/rec/a.txt`);
    noteEdited('/tmp/scratch');
    const log = sessionLog();
    stop();
    expect(log.entries.map((e) => [e.line, e.cwd.replace(HOME, '~'), e.cwdAfter.replace(HOME, '~'), e.status, e.changed.map((p) => p.replace(HOME, '~'))])).toEqual([
      ['mkdir rec && cd rec', '~', '~/rec', 0, ['~/rec']],
      ['echo one > a.txt', '~/rec', '~/rec', 0, ['~/rec/a.txt']],
      ['ls', '~/rec', '~/rec', 0, []],
      ['cat nothing-here', '~/rec', '~/rec', 1, []],
      ['cd ..', '~/rec', '~', 0, []],
    ]);
    expect(log.edits.map((x) => x.path)).toEqual([`${HOME}/rec/a.txt`]);
    for (const x of log.entries) expect(x.end).toBeGreaterThanOrEqual(x.at);
    // and the script made of it
    const files = new Map(await Promise.all(editedPaths(log).map(async (p) => [p, await fileNow(fs, p)] as const)));
    const t = trimSession({ ...log, home: HOME, cwd: shell.cwd, files });
    expect(t.script).toBe('mkdir rec && cd rec\necho one > a.txt\ncat > a.txt <<\'EOF\'\none\nEOF\ncd ~\n');
    await fs.rm(`${HOME}/rec`, { recursive: true });
  });

  it('noise is not a change: the history file, scratch, caches, an editor\'s swap files', () => {
    for (const p of ['/tmp/x', '/home/user/.bash_history', '/home/user/p/__pycache__/a.pyc', '/home/user/.cache/pip/x', '/home/user/p/.a.c.swp', '/home/user/p/a.c~', '/home/user/.viminfo', '/home/user/p/4913', '/var/lib/tabcomputer/apps.json', '/proc/1/stat', '/home/user/.npm/_logs/x.log']) expect(NOISE.test(p), p).toBe(true);
    for (const p of ['/home/user/p/a.c', '/home/user/p/.git/HEAD', '/home/user/.gitconfig', '/usr/local/bin/jq', '/home/user/node_modules/x/package.json', '/home/user/.local/lib/python3.13/site-packages/flask/app.py', '/home/user/template', '/home/user/p/swap.txt']) expect(NOISE.test(p), p).toBe(false);
  });

  it('what a file holds now: small text, or why it is not in the link', async () => {
    const { fs } = await createTestShell();
    await fs.mkdir('/tmp/fn', { recursive: true });
    await fs.writeFile('/tmp/fn/a.txt', 'héllo\n');
    await fs.writeFile('/tmp/fn/b.bin', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 254]));
    await fs.writeFile('/tmp/fn/c.txt', 'x'.repeat(FILE_TEXT_MAX + 1));
    await fs.writeFile('/tmp/fn/d.txt', 'bell\x07');
    expect(await fileNow(fs, '/tmp/fn/a.txt')).toEqual({ text: 'héllo\n' });
    expect(await fileNow(fs, '/tmp/fn/b.bin')).toEqual({ skip: 'binary', size: 7 });
    expect(await fileNow(fs, '/tmp/fn/c.txt')).toEqual({ skip: 'large', size: FILE_TEXT_MAX + 1 });
    expect(await fileNow(fs, '/tmp/fn/d.txt')).toEqual({ skip: 'binary', size: 5 });
    expect(await fileNow(fs, '/tmp/fn')).toEqual({ skip: 'folder', size: 0 });
    expect(await fileNow(fs, '/tmp/fn/none')).toEqual({ missing: true });
    await fs.rm('/tmp/fn', { recursive: true });
  });
});

describe('link: what the setup downloaded, by the path it took', () => {
  it('names where a request went', () => {
    const o = 'https://tabcomputer.com';
    expect(classifyUrl('https://registry.npmjs.org/vite/-/vite-6.0.0.tgz', o)).toEqual({ path: 'direct', label: 'npm' });
    expect(classifyUrl('https://files.pythonhosted.org/packages/a/b/flask-3.1.0-py3-none-any.whl', o)).toEqual({ path: 'direct', label: 'PyPI' });
    expect(classifyUrl('https://pypi.org/simple/flask/', o)).toEqual({ path: 'direct', label: 'PyPI' });
    expect(classifyUrl('https://raw.githubusercontent.com/a/b/HEAD/x', o)).toEqual({ path: 'direct', label: 'GitHub' });
    expect(classifyUrl('https://api.github.com/gists/abc', o)).toEqual({ path: 'direct', label: 'GitHub' });
    expect(classifyUrl('https://example.org/big.bin', o)).toEqual({ path: 'direct', label: 'example.org' });
    expect(classifyUrl(`${o}/debian/chunks/ab/cdef`, o)).toEqual({ path: 'site', label: 'Debian packages' });
    expect(classifyUrl(`${o}/debian/layers/set?packages=jq`, o)).toEqual({ path: 'site', label: 'Debian packages' });
    expect(classifyUrl(`${o}/pyodide/numpy.whl`, o)).toEqual({ path: 'site', label: 'Pyodide' });
    expect(classifyUrl('/pkg/python3/python.wasm', o)).toEqual({ path: 'site', label: 'tabcomputer packages' });
    expect(classifyUrl(`${o}/git-proxy/github.com/a/b/info/refs`, o)).toEqual({ path: 'relay', label: 'git' });
    // a local build takes its packages from the site
    expect(classifyUrl('https://tabcomputer.com/pkg/jq/jq.wasm', 'http://localhost:6871')).toEqual({ path: 'site', label: 'tabcomputer packages' });
    // the page itself, an app's own origin, and what is no request
    for (const u of [`${o}/assets/index-abc.js`, `${o}/`, `${o}/api/anthropic/v1/messages`, 'https://app--x--0123.web.tabcomputer.com/__tabcomputer/frame.html', 'http://app--x--0123.localhost:6871/a', 'blob:https://tabcomputer.com/1', 'data:text/plain,x']) expect(classifyUrl(u, o), u).toBeNull();
  });

  it('does not count a fetch the browser refused', () => {
    // What Chrome records (tests/browser/link-is-computer.mjs `relay`, and a fetch of each kind by hand):
    // refused for CORS, allowed by CORS, and a browser that records no status
    expect(received({ initiatorType: 'fetch', responseStatus: 0 })).toBe(false);
    expect(received({ initiatorType: 'xmlhttprequest', responseStatus: 0 })).toBe(false);
    expect(received({ initiatorType: 'fetch', responseStatus: 200 })).toBe(true);
    expect(received({ initiatorType: 'fetch' })).toBe(true);
    // (a script or an image from another site has status 0 and did arrive)
    expect(received({ initiatorType: 'script', responseStatus: 0 })).toBe(true);
  });

  it('says it in a sentence for each path, and warns when the relay carried a lot', () => {
    const before = [{ path: 'direct' as const, label: 'npm', files: 2, bytes: 1000 }];
    const after = [{ path: 'direct' as const, label: 'npm', files: 16, bytes: 1_201_000 }, { path: 'site' as const, label: 'Debian packages', files: 41, bytes: 88_000_000 }, { path: 'relay' as const, label: 'example.org', files: 0, bytes: 310_000 }, { path: 'direct' as const, label: 'GitHub', files: 2, bytes: 0 }];
    const delta = tallySince(before, after);
    expect(delta.find((r) => r.label === 'npm')).toEqual({ path: 'direct', label: 'npm', files: 14, bytes: 1_200_000 });
    const said = downloadSentences(delta);
    expect(said.lines).toEqual([
      'Straight from the browser: npm 14 files, 1.2 MB; GitHub 2 files.',
      'From this site\'s own files: Debian packages 41 files, 88.0 MB.',
      'Through this site\'s relay: example.org 310 KB.',
    ]);
    expect(said.warning).toBe('');
    expect(downloadSentences([]).lines).toEqual(['The commands in the link downloaded nothing here.']);
    const big = downloadSentences(sumTally([delta, [{ path: 'relay', label: 'example.org', files: 0, bytes: RELAY_WARN_BYTES }], [{ path: 'relay', label: 'git', files: 3, bytes: 2_000_000 }]]));
    expect(big.relayBytes).toBe(310_000 + RELAY_WARN_BYTES + 2_000_000);
    expect(big.lines[2]).toBe('Through this site\'s relay: example.org 5.3 MB; git 3 files, 2.0 MB.');
    expect(big.warning).toMatch(/^7\.3 MB went through this site's relay\. The relay is the part that costs this site each time someone opens the link\./);
    expect(tallySince(after, after)).toEqual([]);
  });
});

describe('link: the command\'s result', () => {
  it('the script, its link, the size line for each form, and the downloads of the lines it keeps', async () => {
    const s = SESSIONS.find((x) => x.name === 'a Flask hello')!;
    const entries = s.entries.map((e) => ({ ...e, net: e.line === 'pip install flask' ? [{ path: 'direct' as const, label: 'PyPI', files: 7, bytes: 680_000 }] : e.line === 'ls' ? [{ path: 'relay' as const, label: 'example.org', files: 0, bytes: 9_000_000 }] : [] }));
    const made = await buildLink({ entries, edits: [], home: HOME, cwd: s.cwd, files: s.files, origin: ORIGIN });
    expect(made.script).toBe(s.script);
    expect(made.link.form).toBe('readable');
    expect(made.sizeLine).toBe(`The script fits in a link a person can read: ${made.link.url.length} characters.`);
    // only the lines that are kept count: `ls` is dropped, so its relay bytes are not the link's
    expect(made.downloads.lines).toEqual(['Straight from the browser: PyPI 7 files, 680 KB.']);
    expect(made.downloads.warning).toBe('');
    // the link opens as the same commands, through the Run / Cancel window
    const prompts: string[] = [];
    const deps: RunLinkDeps = {
      search: '', hash: new URL(made.link.url).hash, origin: ORIGIN, home: HOME, framed: false, fetch: async () => new Response('no', { status: 404 }),
      fs: { mkdir: async () => {}, writeFile: async () => {}, exists: async () => false }, cleanUrl: () => {},
      confirm: async (info) => { prompts.push(info.script); return false; }, openTerminal: () => {}, report: () => {},
    };
    expect(await handleRunLink(deps)).toBe('cancelled');
    expect(prompts).toEqual([s.script]);
    // a script edited by the person: the link is made of their text
    const edited = await buildLink({ script: 'echo mine\n', origin: ORIGIN });
    expect(edited.link.url).toBe(`${ORIGIN}/#echo%20mine`);
    const long = await buildLink({ script: Array.from({ length: 200 }, (_v, i) => `echo "step ${i}: the quick brown fox jumps over the lazy dog"`).join('\n'), origin: ORIGIN });
    expect(long.link.form).toBe('compressed');
    expect(long.sizeLine).toBe(`The script is too long to read in a link, so the link holds it compressed: ${long.link.url.length.toLocaleString('en-US')} characters. A link holds up to 48,000.`);
    let noise = '';
    let seed = 7;
    while (noise.length < 60_000) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; noise += seed.toString(36); }
    const gist = await buildLink({ script: `echo ${noise}`, origin: ORIGIN });
    expect(gist.link.form).toBe('gist');
    expect(gist.sizeLine).toMatch(/^The script is too long for a link: [\d,]+ characters compressed, and a link holds up to 48,000\. A gist can hold it\. Making a gist needs a GitHub sign-in\.$/);
    expect((await buildLink({ script: '', origin: ORIGIN })).sizeLine).toBe('There is nothing to put in a link yet: no line typed in this tab changed anything.');
  });

  it('link at a prompt without a desktop: the script, its link, a file to edit, and link(1) for two files', async () => {
    const { fs, shell } = await createTestShell();
    shell.commands.register(linkCmd);
    resetSessionLog();
    const stop = watchSessionFs(fs);
    for (const p of [`${HOME}/lk`, `${HOME}/setup.sh`]) await fs.rm(p, { recursive: true }).catch(() => {});
    shell.cwd = HOME;
    const sh = async (line: string) => { const r = await run(shell, line); return { code: r.exitCode, out: r.output.replace(/\r\n/g, '\n') }; };
    const typed = async (line: string) => { const rec = sessionStart(line, shell.cwd); const r = await sh(line); sessionEnd(rec, r.code, shell.cwd); };
    expect((await sh('link')).out).toBe('There is nothing to put in a link yet: no line typed in this tab changed anything.\n');
    expect((await sh('link --print')).code).toBe(1);
    await typed('mkdir lk');
    await typed('ls lk');
    await typed('echo hi > lk/a.txt');
    const said = await sh('link');
    expect(said.code).toBe(0);
    expect(said.out).toContain('The script:\n\n  mkdir lk\n  echo hi > lk/a.txt\n\nThe script fits in a link a person can read: ');
    expect(said.out).toContain('What the script downloaded here: The commands in the link downloaded nothing here.');
    expect(said.out).toContain('1 line was left out (link --why says why).');
    expect(said.out).toContain(`\n${SITE}/#mkdir%20lk%0Aecho%20hi%20%3E%20lk/a.txt\n`);
    expect(said.out).toContain('The person who opens the link sees these commands and chooses Run before anything runs.');
    expect(said.out).toContain('To change the script: link -o setup.sh, edit setup.sh, then link setup.sh.');
    expect((await sh('link --print')).out).toBe(`${SITE}/#mkdir%20lk%0Aecho%20hi%20%3E%20lk/a.txt\n`);
    expect((await sh('link --script')).out).toBe('mkdir lk\necho hi > lk/a.txt\n');
    expect((await sh('link --why')).out).toBe('ls lk\n    left out: looking around\nmkdir lk\n    kept: changed files\necho hi > lk/a.txt\n    kept: changed files\n');
    // the script to a file, edited, and the link for the file
    expect((await sh('link -o setup.sh')).out).toBe('The script is in setup.sh (2 lines). Edit it, then: link setup.sh\n');
    await fs.writeFile(`${HOME}/setup.sh`, 'mkdir lk\necho bye > lk/a.txt\n');
    expect((await sh('link --print setup.sh')).out).toBe(`${SITE}/#mkdir%20lk%0Aecho%20bye%20%3E%20lk/a.txt\n`);
    expect((await sh('link nothing.sh')).out).toMatch(/link: nothing\.sh: no such file/);
    expect((await sh('link lk')).out).toMatch(/link: lk is a folder/);
    expect((await sh('link --bogus')).code).toBe(2);
    expect((await sh('link --help')).out).toMatch(/A link from what you did in this tab/);
    // link(1): a second name for a file
    expect((await sh('link lk/a.txt lk/b.txt && cat lk/b.txt')).out).toBe('hi\n');
    stop();
    await fs.rm(`${HOME}/lk`, { recursive: true });
    await fs.rm(`${HOME}/setup.sh`);
  });
});
