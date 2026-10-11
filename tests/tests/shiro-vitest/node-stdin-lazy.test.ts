/**
 * node reads piped stdin when the program does, not before it starts (tabcomputer#66):
 * a script that only mentions readFileSync(0) runs at once on an open pipe, readFileSync(0)
 * blocks until EOF, a consumer gets data as it comes, `timeout` can stop a node waiting on
 * stdin, and process.exit() in a stdin handler is a quiet exit. Run as kernel guests, the
 * stdin a pipe that a parent node holds open for 3 s (as an agent's shell does).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestShell } from './helpers';
import { installNodeWorker } from './node-worker-setup';

let cleanup: () => void;
beforeAll(async () => { cleanup = await installNodeWorker(); }, 120_000);
afterAll(() => cleanup?.());

// The child's stdout with times (+N ms since the parent started), and when it ended
const PARENT = `const t = Date.now(); const [how, cmd] = [process.argv[2], process.argv[3]];
const c = require("child_process").spawn(how === "sh" ? "sh" : "node", how === "sh" ? ["-c", cmd] : [cmd], { stdio: ["pipe", "pipe", "inherit"] });
c.stdout.on("data", (d) => process.stdout.write(String(d).replace(/@/g, () => "+" + (Date.now() - t))));
c.on("exit", (code) => console.log("exit", code, Date.now() - t < 2500 ? "early" : "late"));
setTimeout(() => { c.stdin.write("late\\n"); c.stdin.end(); }, 3000);
`;
const FILES: Record<string, string> = {
  // mentions stdin, never reads it
  'e.cjs': 'console.log("start @");\nif (process.argv.length > 99) require("fs").readFileSync(0);\n',
  'r.cjs': 'console.log("start @"); console.log(JSON.stringify(require("fs").readFileSync(0, "utf8")), "@");\n',
  'r.mjs': 'import { readFileSync } from "node:fs";\nconsole.log("start @"); console.log(JSON.stringify(readFileSync("/dev/stdin", "utf8")), "@");\n',
  's.cjs': 'process.stdin.on("data", (d) => console.log("data", JSON.stringify(String(d)), "@"));\n',
  // (the time since it started: no parent marks it)
  't.cjs': 'const t = Date.now(); process.stdin.on("data", (d) => console.log("data", JSON.stringify(String(d)), "+" + (Date.now() - t)));\n',
};

async function run(cmd: string) {
  const { shell, fs } = await createTestShell();
  await fs.mkdir('/tmp/sl', { recursive: true });
  await fs.writeFile('/tmp/sl/parent.cjs', PARENT);
  for (const [f, src] of Object.entries(FILES)) await fs.writeFile(`/tmp/sl/${f}`, src);
  let out = '';
  await shell.execute(`cd /tmp/sl && ${cmd}`, (s) => { out += s; }, (s) => { out += s; });
  // times: under 2 s is "soon", over 2.5 s "after the pipe closed"
  return out.replace(/\r\n/g, '\n').replace(/\+(\d+)/g, (_, ms) => (+ms < 2000 ? 'soon' : +ms > 2500 ? 'after' : `?${ms}`));
}

describe('node reads piped stdin when the program does (#66)', () => {
  it('a script that only mentions readFileSync(0) starts and ends at once', async () => {
    expect(await run('node parent.cjs sh "node e.cjs"')).toBe('start soon\nexit 0 early\n');
    expect(await run('node parent.cjs node e.cjs')).toBe('start soon\nexit 0 early\n');
  }, 60_000);

  it('readFileSync(0) and /dev/stdin start at once and block until EOF', async () => {
    expect(await run('node parent.cjs sh "node r.cjs"')).toBe('start soon\n"late\\n" after\nexit 0 late\n');
    expect(await run('node parent.cjs sh "node r.mjs"')).toBe('start soon\n"late\\n" after\nexit 0 late\n');
  }, 60_000);

  it('timeout stops a node blocked on stdin', async () => {
    expect(await run('node parent.cjs sh "timeout 1 node r.cjs; echo rc=\\$?"')).toBe('start soon\nrc=124\nexit 0 early\n');
  }, 60_000);

  it('a stdin consumer gets data as it comes, from another node too', async () => {
    expect(await run('node parent.cjs sh "node s.cjs"')).toBe('data "late\\n" after\nexit 0 late\n');
    expect(await run(`node -e 'console.log("a"); setTimeout(() => console.log("b"), 3000)' | node t.cjs`)).toBe('data "a\\n" soon\ndata "b\\n" after\n');
  }, 60_000);

  it('process.exit() in a stdin handler exits quietly with its code', async () => {
    expect(await run(`node parent.cjs sh "node -e 'process.stdin.once(\\"data\\", () => process.exit(3))'; echo rc=\\$?"`)).toBe('rc=3\nexit 0 late\n');
  }, 60_000);
});
