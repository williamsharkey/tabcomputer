// gh extensions (tabcomputer#127) in Chromium.
//
// Against a stand-in GitHub (the REST API of tests/tests/shiro-vitest/
// git-github-api-fake.ts answers from this script; no account, nothing
// leaves the machine):
//   precompiled   `gh extension install ada/gh-tool` takes the release's linux-amd64 asset,
//                 a real static x86-64 program, and `gh tool a b` runs it in the emulator,
//                 in the default network mode and in private mode
//   script        `gh extension install ada/gh-hello` clones it (private mode: git over the
//                 REST API) and `gh hello` runs it with GH_TOKEN from the tab's sign-in
//   the rest      list at a terminal, upgrade, exec, remove, a release with no linux build
//
// With --real, read-only against github.com and without any sign-in: a public
// script extension, a public precompiled one, and Classroom 50's `gh student`
// (`--help`, and how far a command gets with no account). The server needs
// the relay for what the programs themselves fetch:
//
//   npx vite build && PORT=6741 STATIC_DIR=$PWD/dist TABCOMPUTER_TCP_RELAY=1 \
//     TABCOMPUTER_TCP_ORIGINS=http://localhost:6741 node server.mjs &
//   node tests/browser/gh-extension.mjs http://localhost:6741/ [--real] [--shots DIR]
//
// Node 22.18+ (it imports the TypeScript stand-in as it is). CHROMIUM= picks the browser.
import { mkdirSync, readFileSync } from 'node:fs';
import { fakeGitHub } from '../tests/shiro-vitest/git-github-api-fake.ts';
import { chromiumPath, joinWrappedRows, loadPlaywright } from './_browser.mjs';
const { chromium } = loadPlaywright();

const argv = process.argv.slice(2);
const take = (name) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
const real = take('--real');
const shotsAt = argv.indexOf('--shots');
const shots = shotsAt < 0 ? null : argv.splice(shotsAt, 2)[1];
const url = (argv[0] ?? 'http://localhost:6741/').replace(/\?.*$/, '');
if (shots) mkdirSync(shots, { recursive: true });
const exe = chromiumPath('/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !detail ? '' : `\n     ${String(detail).trim().split('\n').slice(-12).join('\n     ')}`}`); if (!ok) failed++; };

// ── The stand-in GitHub ──
const TOKEN = 'gho_' + 'd'.repeat(36);
const enc = new TextEncoder();
function commit(gh, files, message) {
  const parts = [];
  for (const [name, text] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    parts.push(Buffer.from(`${name.startsWith('gh-') ? '100755' : '100644'} ${name}\0`), Buffer.from(gh.put('blob', enc.encode(text)), 'hex'));
  }
  const tree = gh.put('tree', new Uint8Array(Buffer.concat(parts)));
  const who = 'Ada Lovelace <ada@example.org> 1700000000 +0000';
  const parent = gh.refs.get('main');
  const tip = gh.put('commit', enc.encode(`tree ${tree}\n${parent ? `parent ${parent}\n` : ''}author ${who}\ncommitter ${who}\n\n${message}\n`));
  gh.refs.set('main', tip);
  return tip;
}
const HELLO = (word) => `#!/usr/bin/env bash
set -e
if [ "$1" = "--help" ]; then echo "Usage: gh hello [NAME]"; exit 0; fi
echo "${word} \${1:-world} from $(basename "$0")"
echo "token \${GH_TOKEN:+is set}"
`;
const hello = fakeGitHub('ada', 'gh-hello');
const helloV1 = commit(hello, { 'gh-hello': HELLO('hello'), 'README.md': '# gh-hello\n' }, 'First');
// (a real static x86-64 Linux program: tests/tests/shiro-vitest/fixtures/x86/hello.c)
const ELF = readFileSync(new URL('../tests/shiro-vitest/fixtures/x86/hello-musl', import.meta.url));
const releases = {
  'ada/gh-tool': { tag_name: 'v1.0.0', assets: [['checksums.txt', Buffer.from('sums\n')], ['gh-tool_v1.0.0_darwin-arm64', Buffer.from('not for here')], ['gh-tool_v1.0.0_linux-amd64', ELF], ['gh-tool_v1.0.0_windows-amd64.exe', Buffer.from('MZ')]] },
  'ada/gh-maconly': { tag_name: 'v2', assets: [['gh-maconly_darwin-arm64', Buffer.from('x')]] },
};
const assetRequests = [];

async function stubGitHub(context) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE', 'access-control-expose-headers': '*' };
  const answer = async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const u = new URL(req.url());
    const path = u.pathname.replace(/^\/api\/github/, '');
    const json = (status, body) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/user') return (req.headers()['authorization'] ?? '').endsWith(TOKEN) ? json(200, { login: 'ada', name: 'Ada Lovelace', id: 9999 }) : json(401, { message: 'Bad credentials' });
    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
    const full = m?.[1];
    const rest = m?.[2] ?? '';
    const rel = full && releases[full];
    if (rest === '/releases/latest') {
      if (!rel) return json(404, { message: 'Not Found' });
      return json(200, { tag_name: rel.tag_name, assets: rel.assets.map(([name, body], i) => ({ name, size: body.length, url: `https://api.github.com/repos/${full}/releases/assets/${i}`, browser_download_url: `https://github.com/${full}/releases/download/${rel.tag_name}/${name}` })) });
    }
    let a;
    if (rel && (a = /^\/releases\/assets\/(\d+)$/.exec(rest))) {
      assetRequests.push(`${u.host}${u.pathname}`);
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/octet-stream', body: rel.assets[Number(a[1])][1] });
    }
    if (full === 'ada/gh-hello') {
      if (rest === '/contents/gh-hello') return json(200, { name: 'gh-hello', type: 'file' });
      if (rest === '') return json(200, { full_name: full, default_branch: 'main', private: false });
      const res = await hello.fetch(`https://${u.host === 'raw.githubusercontent.com' ? u.host : 'api.github.com'}${path}${u.search}`, { method: req.method(), headers: req.headers(), body: req.postData() ?? undefined });
      const headers = { ...cors };
      res.headers.forEach((v, k) => { headers[k] = v; });
      return route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
    }
    return json(404, { message: 'Not Found' });
  };
  await context.route('https://api.github.com/**', answer);
  await context.route('https://raw.githubusercontent.com/**', answer);
  await context.route('**/api/github/**', answer);
}

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });

async function open(stub) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } }); // a fresh profile
  if (stub) await stubGitHub(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${url}?ui=terminal`);
  await page.waitForFunction(() => window.__tabcomputer?.terminal?.term && window.__tabcomputer?.kernel, null, { timeout: 120_000 });
  const bufferOf = async () => joinWrappedRows(await page.evaluate(() => {
    const b = window.__tabcomputer.terminal.term.buffer.active;
    const rows = [];
    for (let y = 0; y < b.length; y++) { const l = b.getLine(y); rows.push({ text: l?.translateToString(false) ?? '', wrapped: !!l?.isWrapped }); }
    return rows;
  }));
  for (let i = 0; i < 300 && !/\$ ?$/m.test(await bufferOf()); i++) await page.waitForTimeout(100);
  await page.waitForTimeout(500);
  /** A command in a shell without a terminal: its output, status and time */
  const sh = (cmd) => page.evaluate(async (cmd) => {
    const s = window.__ghShell ??= Object.assign(window.__tabcomputer.shell.fork(), { terminal: null });
    let out = '';
    const t0 = performance.now();
    const code = await s.execute(cmd, (x) => { out += x; }, (x) => { out += x; });
    return { code, out: out.replace(/\r\n/g, '\n'), ms: Math.round(performance.now() - t0) };
  }, cmd);
  let marks = 0;
  /** A command typed at the real terminal: what it drew */
  const typed = async (cmd) => {
    const mark = `@@gh${++marks}`;
    await page.evaluate(() => window.__tabcomputer.terminal.term.focus());
    await page.keyboard.type(`${cmd}; echo "${mark} $?"\r`, { delay: 2 });
    const re = new RegExp(`^${mark} (\\d+)$`, 'm');
    for (let i = 0; i < 1800; i++) {
      const s = await bufferOf();
      const m = re.exec(s);
      if (m) return { code: Number(m[1]), out: s.slice(0, m.index).split(`echo "${mark} $?"`).pop() ?? '' };
      await page.waitForTimeout(100);
    }
    throw new Error(`timed out: ${cmd}`);
  };
  return { context, page, sh, typed, errors };
}

try {
  // ── stand-in GitHub ──
  {
    const { context, page, sh, typed, errors } = await open(true);
    await page.evaluate((t) => localStorage.setItem('tabcomputer_github_token', t), TOKEN);

    // The default network mode: the asset comes through this site's GitHub route
    let r = await sh('gh extension install ada/gh-tool');
    check(r.code === 0 && assetRequests.at(-1) === new URL(url).host + '/api/github/repos/ada/gh-tool/releases/assets/2', `a precompiled extension installs from its linux-amd64 asset (${r.ms} ms)`, r.out + assetRequests.join(' '));
    r = await sh('gh tool one "two words"');
    check(r.code === 0 && /hello from c\narg1=one\narg2=two words\n/.test(r.out), `gh tool runs the x86-64 program in the emulator (${r.ms} ms)`, r.out);
    r = await sh('gh tool fail; echo "status $?"');
    check(/status 7/.test(r.out), 'its exit status is the program\'s', r.out);
    r = await sh('cat ~/.local/share/gh/extensions/gh-tool/manifest.yml');
    check(/owner: ada\nname: gh-tool\nhost: github\.com\ntag: v1\.0\.0\nispinned: false\n/.test(r.out), 'a manifest.yml beside it records the release', r.out);
    r = await sh('gh extension install ada/gh-maconly');
    check(r.code === 1 && /gh-maconly unsupported for linux-amd64 \(its release has darwin-arm64; this computer runs linux-amd64 programs\)/.test(r.out) && r.out.trim().split('\n').length === 1, 'a release with no linux-amd64 build is refused in one line', r.out);

    // Private mode: the page asks GitHub itself; a script extension is cloned over the REST API
    r = await sh('netmode private');
    check(r.code === 0, 'netmode private', r.out);
    r = await sh('gh extension install ada/gh-hello');
    check(r.code === 0, `a script extension installs (private mode, ${r.ms} ms)`, r.out);
    r = await sh('gh hello Ann');
    check(r.code === 0 && r.out === 'hello Ann from gh-hello\ntoken is set\n', 'gh hello runs it with GH_TOKEN from the sign-in', r.out);
    r = await sh('gh extension remove tool && gh extension install ada/gh-tool && gh tool again');
    check(r.code === 0 && /arg1=again/.test(r.out) && assetRequests.at(-1) === 'api.github.com/repos/ada/gh-tool/releases/assets/2', 'the precompiled one installs and runs in private mode too', r.out + assetRequests.join(' '));

    // At a terminal: the table, and an extension's own output
    let t = await typed('gh extension list');
    check(t.code === 0 && new RegExp(`NAME +REPO +VERSION\\s+gh hello +ada/gh-hello +${helloV1.slice(0, 8)}\\s+gh tool +ada/gh-tool +v1\\.0\\.0`).test(t.out), 'gh extension list at a terminal', t.out);
    t = await typed('gh hello Bo');
    check(t.code === 0 && /hello Bo from gh-hello\s+token is set/.test(t.out), 'gh hello at a terminal', t.out);

    // Upgrade, exec, remove
    const helloV2 = commit(hello, { 'gh-hello': HELLO('hi'), 'README.md': '# gh-hello\n' }, 'Second');
    releases['ada/gh-tool'] = { tag_name: 'v1.1.0', assets: [['gh-tool_v1.1.0_linux-amd64', ELF]] };
    r = await sh('gh extension upgrade --all');
    check(r.code === 0 && r.out.includes(`[hello]: upgraded from ${helloV1.slice(0, 8)} to ${helloV2.slice(0, 8)}`) && r.out.includes('[tool]: upgraded from v1.0.0 to v1.1.0'), 'gh extension upgrade --all', r.out);
    r = await sh('gh extension exec hello');
    check(r.code === 0 && /^hi world from gh-hello\n/.test(r.out), 'the upgraded script runs (gh extension exec)', r.out);
    r = await sh('gh extension remove hello && gh extension remove tool; gh extension list; gh hello');
    check(/no installed extensions found/.test(r.out) && /'hello' is not a valid command/.test(r.out), 'gh extension remove', r.out);
    check(errors.length === 0, 'no page errors', errors.join('; '));
    if (shots) await page.screenshot({ path: `${shots}/gh-extension.png` }).catch(() => {});
    await context.close();
  }

  // ── the real GitHub, read-only, signed in to nothing ──
  if (real) {
    const { context, page, sh, errors } = await open(false);
    const show = (r) => console.log(r.out.trimEnd().split('\n').slice(0, 40).map((l) => `     | ${l}`).join('\n'));
    let r = await sh('gh extension install HaywardMorihara/gh-tidy');
    check(r.code === 0, `real: a public script extension installs (HaywardMorihara/gh-tidy, ${r.ms} ms)`, r.out);
    r = await sh('gh tidy --help');
    check(r.code === 0 && /Usage: gh tidy/.test(r.out), `real: gh tidy --help (${r.ms} ms)`, r.out);
    r = await sh('gh extension install seachicken/gh-poi');
    check(r.code === 0, `real: a public precompiled extension installs (seachicken/gh-poi, ${r.ms} ms)`, r.out);
    r = await sh('gh poi --help');
    check(r.code === 0 && /poi/i.test(r.out), `real: gh poi --help in the emulator (${r.ms} ms)`, r.out);
    show(r);
    r = await sh('gh extension install foundation50/gh-student');
    check(r.code === 0, `real: Classroom 50's gh-student installs (${r.ms} ms)`, r.out);
    r = await sh('gh student --help');
    check(r.code === 0 && /student/i.test(r.out), `real: gh student --help (${r.ms} ms)`, r.out);
    show(r);
    r = await sh('gh extension list');
    show(r);
    // How far its commands get with no account, and with a token GitHub does not know
    // (which shows the program reaching api.github.com through the relay), in both network modes
    for (const cmd of (process.env.GH_STUDENT_TRY || 'gh student accept --help | tail -14;;gh student accept cs50 cs50-fall-2026 hello;;gh student submit').split(';;')) {
      r = await sh(`${cmd}; echo "status $?"`);
      console.log(`     $ ${cmd}  (${r.ms} ms)`);
      show(r);
    }
    for (const mode of ['proxy', 'private']) {
      r = await sh(`netmode ${mode} > /dev/null; ${process.env.GH_STUDENT_API || 'gh student whoami'}; echo "status $?"`);
      console.log(`     $ ${process.env.GH_STUDENT_API || 'gh student whoami'}  (no sign-in, netmode ${mode}, ${r.ms} ms)`);
      show(r);
      r = await sh(`GH_TOKEN=ghp_${'0'.repeat(36)} ${process.env.GH_STUDENT_API || 'gh student whoami'}; echo "status $?"`);
      console.log(`     $ GH_TOKEN=<one GitHub does not know> ${process.env.GH_STUDENT_API || 'gh student whoami'}  (netmode ${mode}, ${r.ms} ms)`);
      show(r);
      check(/401|Bad credentials|authenticat/i.test(r.out), `real: a precompiled extension reaches api.github.com through the relay (netmode ${mode})`, r.out);
    }
    r = await sh('dmesg | tail -5');
    show(r);
    check(errors.length === 0, 'real: no page errors', errors.join('; '));
    await context.close();
  }
} catch (e) {
  failed++;
  console.log(`FAIL ${e.stack ?? e}`);
}
await browser.close();
console.log(failed ? `${failed} failed` : 'ok');
process.exit(failed ? 1 : 0);
