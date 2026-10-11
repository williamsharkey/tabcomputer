/**
 * fs.rmSync(dir, { recursive: true }) removes the whole tree, as node's: directories and
 * files this script never read too (they stayed, in the page and as a guest), and a tree
 * made again right after it isn't undone by a removal landing late.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestShell } from './helpers';
import { installNodeWorker } from './node-worker-setup';

let cleanup: () => void;
beforeAll(async () => { cleanup = await installNodeWorker(); }, 120_000);
afterAll(() => cleanup?.());

describe.each([['in the page', 'TABCOMPUTER_NODE_WORKER=0'], ['as a kernel guest', 'TABCOMPUTER_NODE_WORKER=1']])('fs.rmSync recursive, node %s', (_where, env) => {
  it('removes the tree; one made again at once stays', async () => {
    const { shell } = await createTestShell();
    let out = '';
    const dir = `/home/user/rr-${env.slice(-1)}`;
    await shell.execute(`mkdir -p ${dir}/D/sub/deeper && echo 1 > ${dir}/D/a && echo 2 > ${dir}/D/sub/b && ln -s a ${dir}/D/L && cd ${dir} && ${env} node -e '
const fs = require("fs");
fs.readFileSync("D/a");
fs.rmSync("D", { recursive: true, force: true });
console.log(fs.existsSync("D"), fs.existsSync("D/a"), fs.existsSync("D/sub"));
fs.mkdirSync("D/sub", { recursive: true }); fs.writeFileSync("D/sub/new", "n"); fs.symlinkSync("sub/new", "D/L2");
console.log(fs.realpathSync("D/L2") === fs.realpathSync("D/sub/new"));
' && find D | sort && cat D/sub/new`, (s) => { out += s; }, (s) => { out += s; });
    expect(out.replace(/\r\n/g, '\n')).toBe('false false false\ntrue\nD\nD/L2\nD/sub\nD/sub/new\nn');
  }, 60_000);
});
