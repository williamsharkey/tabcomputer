/**
 * tabcomputer#95: Claude Code's Grep and Glob (claude --vm, 2.1.296) searched the
 * session's directory instead of their `path`. For a directory they run
 * `execFile(rg, [...flags, '.'], { cwd: <the directory> })` and put the path
 * back on each relative result; execFile (and exec) dropped `cwd`, so rg
 * walked node's own directory and the results were named as files under `path`.
 *
 * The script below prepares a search as Claude Code does: the rg on PATH by its
 * absolute path, the first-use probe (#57: `rg --version` must start with
 * "ripgrep "), the target opened and, where /proc/self/fd/N names it, searched
 * through that descriptor; otherwise by its path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestShell } from './helpers';
import { installNodeWorker } from './node-worker-setup';
import { installPathShims } from '@shiro/path-shims';

let cleanup: () => void;
beforeAll(async () => { cleanup = await installNodeWorker(); }, 120_000);
afterAll(() => cleanup?.());

const DIR = '/tmp/vm-grep-glob';

async function node(worker: boolean, script: string) {
  const { shell, fs } = await createTestShell();
  await installPathShims(fs); // /usr/local/bin/rg, as boot writes it
  await fs.mkdir(`${DIR}/work/sub dir`, { recursive: true });
  await fs.mkdir(`${DIR}/session/other`, { recursive: true });
  await fs.writeFile(`${DIR}/work/a.txt`, 'alpha\nbeta needle\n');
  await fs.writeFile(`${DIR}/work/sub dir/b.md`, 'needle two\n');
  await fs.writeFile(`${DIR}/session/other/c.md`, 'needle elsewhere\n');
  await fs.writeFile(`${DIR}/script.js`, script);
  let out = '';
  await shell.execute(`export TABCOMPUTER_NODE_WORKER=${worker ? 1 : 0}; cd ${DIR}/session; node ${DIR}/script.js < /dev/null`, (s) => { out += s; }, (s) => { out += s; });
  return out.replace(/\r\n/g, '\n');
}

/** Claude Code 2.1.296's search of `path` with `flags`, reduced to what decides rg's argv, cwd and stdio */
const SEARCH = `
const fs = require('fs'), fsp = require('fs/promises'), path = require('path'), cp = require('child_process');
const rg = process.env.PATH.split(':').map((d) => d + '/rg').find((p) => fs.existsSync(p));
async function search(flags, lexical) {
  const h = await fsp.open(lexical, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const dir = (await h.stat()).isDirectory();
    let link = null;
    try { link = await fsp.readlink('/proc/self/fd/' + h.fd); } catch {}
    const viaFd = link !== null;
    const t = dir ? { cwd: viaFd ? '/proc/self/fd/' + h.fd : fs.realpathSync(lexical), target: '.', relative: true }
      : { cwd: path.dirname(lexical), target: viaFd ? '/proc/self/fd/3' : lexical, inheritFd: viaFd ? h.fd : undefined };
    const out = await new Promise((resolve, reject) => {
      const done = (err, stdout) => (!err || err.code === 1 ? resolve(stdout) : reject(Object.assign(err, { stdout })));
      if (t.inheritFd === undefined) return cp.execFile(rg, [...flags, t.target], { cwd: t.cwd, maxBuffer: 20000000, timeout: 20000, killSignal: 'SIGKILL', windowsHide: true }, done);
      const c = cp.spawn(rg, [...flags, t.target], { stdio: ['pipe', 'pipe', 'pipe', t.inheritFd], cwd: t.cwd, windowsHide: true });
      let stdout = '';
      c.stdout.on('data', (d) => { stdout += d; });
      c.on('close', (code) => done(code ? { code } : null, stdout));
      c.on('error', reject);
    });
    const names = out.split('\\0').filter((n) => n && n !== '\\n');
    return names.map((n) => (t.relative ? path.join(lexical, n) : n === t.target ? lexical : n)).sort();
  } finally { await h.close(); }
}
const GREP = ['--hidden', '--glob', '!.git', '--max-columns', '500', '-l', '--null', 'needle'];
const glob = (pattern) => ['--files', '--null', '--glob', pattern, '--sort=modified', '--no-ignore', '--hidden'];
`;

describe.each([['page', false], ['worker', true]])("Claude Code's Grep and Glob on node (%s mode)", (_mode, worker) => {
  it('search the path they are given, not the session directory', async () => {
    const out = await node(worker, SEARCH + `
(async () => {
  const probe = await new Promise((r) => cp.execFile(rg, ['--version'], { timeout: 5000 }, (err, stdout) => r(!err && stdout.startsWith('ripgrep '))));
  console.log(JSON.stringify({
    rgAbsolute: path.isAbsolute(rg), probe,
    grepDir: await search(GREP, '${DIR}/work'),
    grepSub: await search(GREP, '${DIR}/work/sub dir'),
    grepFile: await search(GREP, '${DIR}/work/a.txt'),
    globDir: await search(glob('*.md'), '${DIR}/work'),
    globAll: await search(glob('**/*'), '${DIR}/work/sub dir'),
  }));
})();
`);
    expect(JSON.parse(out)).toEqual({
      rgAbsolute: true, probe: true,
      grepDir: [`${DIR}/work/a.txt`, `${DIR}/work/sub dir/b.md`],
      grepSub: [`${DIR}/work/sub dir/b.md`],
      grepFile: [`${DIR}/work/a.txt`],
      globDir: [`${DIR}/work/sub dir/b.md`],
      globAll: [`${DIR}/work/sub dir/b.md`],
    });
  }, 60_000);

  it('execFile, exec, their promisified forms and execFileSync run in opts.cwd', async () => {
    const out = await node(worker, `
const cp = require('child_process'), { promisify } = require('util');
const cwd = '${DIR}/work/sub dir';
(async () => {
  const seen = [];
  seen.push(await new Promise((r) => cp.execFile('pwd', [], { cwd }, (e, o) => r(o.trim()))));
  seen.push(await new Promise((r) => cp.exec('pwd', { cwd }, (e, o) => r(o.trim()))));
  seen.push((await promisify(cp.execFile)('pwd', [], { cwd })).stdout.trim());
  seen.push((await promisify(cp.exec)('pwd', { cwd })).stdout.trim());
  seen.push(String(await cp.execFileSync('pwd', [], { cwd })).trim());
  // (and without one: node's own directory)
  seen.push(await new Promise((r) => cp.execFile('pwd', [], (e, o) => r(o.trim()))));
  console.log(JSON.stringify(seen));
})();
`);
    expect(JSON.parse(out)).toEqual([...Array(5).fill(`${DIR}/work/sub dir`), `${DIR}/session`]);
  }, 60_000);
});
