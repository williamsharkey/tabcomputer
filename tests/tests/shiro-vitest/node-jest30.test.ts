/**
 * jest 30 end to end (tabcomputer#81), from the npm registry: set
 * TABCOMPUTER_NPM_NET=1. Its resolver (unrs-resolver) loads as napi-rs's
 * WebAssembly binding on node:wasi and worker_threads, so it needs node as a
 * kernel guest; and jest must see that `watchman` is not installed (ENOENT:
 * node-spawn-enoent.test.ts) to crawl the project itself.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestShell } from './helpers';
import { installNodeWorker } from './node-worker-setup';

const NET = !!process.env.TABCOMPUTER_NPM_NET;
let cleanup: (() => void) | undefined;
beforeAll(async () => { if (NET) cleanup = await installNodeWorker(); }, 120_000);
afterAll(() => cleanup?.());

describe.skipIf(!NET)('jest 30 (TABCOMPUTER_NPM_NET=1)', () => {
  it('installs, resolves modules with unrs-resolver, and runs a passing and a failing test', async () => {
    const { shell, fs } = await createTestShell();
    const run = async (cmd: string) => {
      let out = '';
      const code = await shell.execute(`export TABCOMPUTER_NODE_WORKER=1; ${cmd}`, (s) => { out += s; }, (s) => { out += s; });
      return { code, out: out.replace(/\r\n/g, '\n') };
    };
    await fs.mkdir('/home/user/j30', { recursive: true });
    await fs.writeFile('/home/user/j30/package.json', '{"name":"j30","version":"1.0.0","scripts":{"test":"jest"}}');
    await fs.writeFile('/home/user/j30/sum.js', 'module.exports = (a, b) => a + b;\n');
    await fs.writeFile('/home/user/j30/sum.test.js', `const sum = require('./sum');\ntest('adds', () => { expect(sum(1, 2)).toBe(3); });\ntest('fails', () => { expect(sum(1, 2)).toBe(4); });\n`);
    const install = await run('cd /home/user/j30 && npm install jest@30 < /dev/null');
    expect(install.code, install.out.slice(-2000)).toBe(0);
    expect((await run('cd /home/user/j30 && ls node_modules/@unrs')).out).toContain('resolver-binding-wasm32-wasi');
    // the resolver itself: sync, and async on its emnapi thread
    await fs.writeFile('/home/user/j30/resolve.js', `const { ResolverFactory } = require('unrs-resolver');
const f = new ResolverFactory({ extensions: ['.js'] });
console.log(f.sync('/home/user/j30', './sum').path);
const keep = setTimeout(() => { console.log('async never answered'); process.exit(2); }, 20000);
f.async('/home/user/j30', './sum').then((r) => { console.log('async', r.path); clearTimeout(keep); });
`);
    expect((await run('cd /home/user/j30 && node resolve.js < /dev/null')).out).toBe('/home/user/j30/sum.js\nasync /home/user/j30/sum.js\n');
    // jest as a user runs it: no flags
    const jest = await run('cd /home/user/j30 && timeout 200 npx jest --ci < /dev/null');
    expect(jest.out).toContain('✓ adds');
    expect(jest.out).toContain('✕ fails');
    expect(jest.out).toMatch(/Tests:\s+1 failed, 1 passed, 2 total/);
    expect(jest.out).not.toContain('Watchman');
    expect(jest.code).toBe(1);
  }, 500_000);
});
