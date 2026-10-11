/**
 * Running a real project's tests (kleur: `uvu -r esm`) hit three gaps in
 * node-compat's module loading:
 * - require('.') and require('..') were taken for package names and looked up
 *   in node_modules (uvu's bin.js requires '.', its own package);
 * - a script run through a symlink (node_modules/.bin/uvu -> ../uvu/bin.js)
 *   resolved its relative requires from the link's directory; node uses the
 *   real path unless --preserve-symlinks-main;
 * - require('module') wasn't the Module constructor (the esm package does
 *   `new (require('module'))(id)`: "f is not a constructor").
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestShell, run } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

let shell: Shell;
let fs: FileSystem;
const out = async (cmd: string) => (await run(shell, `${cmd} < /dev/null`)).output.replace(/\r\n/g, '\n');

beforeAll(async () => {
  ({ shell, fs } = await createTestShell());
  await fs.mkdir('/tmp/rd/node_modules/pkg/lib', { recursive: true });
  await fs.mkdir('/tmp/rd/node_modules/.bin', { recursive: true });
  await fs.writeFile('/tmp/rd/node_modules/pkg/package.json', JSON.stringify({ name: 'pkg', main: 'main.js' }));
  await fs.writeFile('/tmp/rd/node_modules/pkg/main.js', 'module.exports = "pkg main";\n');
  await fs.writeFile('/tmp/rd/node_modules/pkg/lib/index.js', 'module.exports = "lib index";\n');
  await fs.writeFile('/tmp/rd/node_modules/pkg/lib/dot.js', 'console.log(require("."), "|", require(".."));\n');
  await fs.writeFile('/tmp/rd/node_modules/pkg/bin.js', 'console.log(require("."), "|", require("./lib"), "|", __dirname);\n');
  await run(shell, 'ln -s ../pkg/bin.js /tmp/rd/node_modules/.bin/pkg');
});

describe('node-compat module loading', () => {
  it("require('.') and require('..') are relative to the file", async () => {
    expect(await out('cd /tmp/rd && node node_modules/pkg/lib/dot.js')).toBe('lib index | pkg main\n');
  });

  it('a script run through a symlink resolves from its real path', async () => {
    expect(await out('cd /tmp/rd && node node_modules/.bin/pkg')).toBe('pkg main | lib index | /tmp/rd/node_modules/pkg\n');
  });

  it('--preserve-symlinks-main keeps the link\'s directory (so ./lib is looked for next to the link)', async () => {
    expect(await out('cd /tmp/rd && node --preserve-symlinks-main node_modules/.bin/pkg 2>&1')).toMatch(/Cannot find module/);
  });

  it("require('module') is the Module constructor, its helpers static on it", async () => {
    const r = await out(`node -e 'const M = require("module"); const m = new M("x"); console.log(typeof M, m.id, M.Module === M, typeof M.createRequire, M.builtinModules.includes("fs"), M.isBuiltin("node:path"))'`);
    expect(r).toBe('function x true function true true\n');
  });
});
