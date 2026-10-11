/**
 * What a zero-dependency node project uses (tabcomputer#67): util.parseArgs reading
 * process.argv, node:test and `node --test`, and npm's pkg, ci, version, view, root and
 * `run -s`. Output compared with node 22 and npm 10's.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestShell } from './helpers';
import { installNodeWorker } from './node-worker-setup';

let cleanup: () => void;
beforeAll(async () => { cleanup = await installNodeWorker(); }, 120_000);
afterAll(() => cleanup?.());

async function shellIn(dir: string, files: Record<string, string> = {}) {
  const { shell, fs } = await createTestShell();
  await fs.mkdir(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    await fs.mkdir(`${dir}/${f}`.replace(/\/[^/]+$/, ''), { recursive: true });
    await fs.writeFile(`${dir}/${f}`, text);
  }
  const run = async (cmd: string) => {
    let out = '';
    const code = await shell.execute(`cd ${dir} && ${cmd}`, (s) => { out += s; }, (s) => { out += s; });
    return { code, out: out.replace(/\r\n/g, '\n') };
  };
  return { run, fs };
}
/** (durations vary) */
const stable = (s: string) => s.replace(/duration_ms: [\d.]+/g, 'duration_ms: D').replace(/\(([\d.]+)ms\)/g, '(Dms)').replace(/duration_ms [\d.]+/g, 'duration_ms D');

describe('util.parseArgs (#67)', () => {
  it("reads process.argv by default, omits absent booleans, tokens only when asked", async () => {
    const { run } = await shellIn('/home/user/pa', {
      'pa.mjs': `import { parseArgs } from 'node:util';\nconsole.log(JSON.stringify(parseArgs({ options: { top: { type: 'string', short: 'n', default: '10' }, json: { type: 'boolean' } }, allowPositionals: true })));\n`,
      'e.cjs': `const { parseArgs } = require('util');
for (const c of [{ args: ['-vvx', '-fF', 'p'], options: { v: { type: 'boolean', short: 'v', multiple: true }, x: { type: 'boolean', short: 'x' }, f: { type: 'string', short: 'f' } }, allowPositionals: true, tokens: true }, { args: ['--nope'] }, { args: ['pos'] }, { args: ['-n', '-x'], options: { n: { type: 'string', short: 'n' } } }])
  try { console.log(JSON.stringify(parseArgs(c))); } catch (e) { console.log(e.code); }\n`,
    });
    expect((await run('node pa.mjs --json -n 3 file.txt < /dev/null')).out).toBe('{"values":{"json":true,"top":"3"},"positionals":["file.txt"]}\n');
    expect((await run('node pa.mjs < /dev/null')).out).toBe('{"values":{"top":"10"},"positionals":[]}\n');
    expect((await run('node e.cjs < /dev/null')).out).toBe(
      '{"values":{"v":[true,true],"x":true,"f":"F"},"positionals":["p"],"tokens":[{"kind":"option","name":"v","rawName":"-v","index":0},{"kind":"option","name":"v","rawName":"-v","index":0},{"kind":"option","name":"x","rawName":"-x","index":0},{"kind":"option","name":"f","rawName":"-f","index":1,"value":"F","inlineValue":true},{"kind":"positional","index":2,"value":"p"}]}\n'
      + 'ERR_PARSE_ARGS_UNKNOWN_OPTION\nERR_PARSE_ARGS_UNEXPECTED_POSITIONAL\nERR_PARSE_ARGS_INVALID_OPTION_VALUE\n');
  }, 60_000);
});

const A_TEST = `const { test, describe, it, before, mock } = require('node:test');
const assert = require('node:assert');
test('adds', () => { assert.strictEqual(1 + 1, 2); });
describe('math', () => {
  it('inner', () => {});
  it('inner fail', () => { assert.strictEqual(1, 2); });
  it.skip('skipped one', () => {});
  it.todo('todo one');
});
test('subtests', async (t) => { await t.test('sub a', () => {}); });
test('mock', () => { const f = mock.fn((x) => x * 2); f(2); f(3); assert.strictEqual(f.mock.callCount(), 2); assert.deepStrictEqual(f.mock.calls[1].arguments, [3]); });
`;

describe('node:test and node --test (#67)', () => {
  it('a test file: TAP when not on a terminal, spec with --test-reporter, exit 1 on a failure', async () => {
    const { run } = await shellIn('/home/user/nt1', { 'test/a.test.js': A_TEST });
    const tap = await run('node test/a.test.js < /dev/null; echo rc=$?');
    expect(stable(tap.out)).toContain('TAP version 13\n# Subtest: adds\nok 1 - adds\n  ---\n  duration_ms: D\n  type: \'test\'\n  ...\n# Subtest: math\n    # Subtest: inner\n    ok 1 - inner\n');
    expect(tap.out).toContain("    not ok 2 - inner fail\n");
    expect(tap.out).toContain("      failureType: 'testCodeFailure'\n      error: |-\n        Expected values to be strictly equal:\n");
    expect(tap.out).toContain('    ok 3 - skipped one # SKIP\n');
    expect(tap.out).toContain('    ok 4 - todo one # TODO\n');
    expect(tap.out).toContain("not ok 2 - math\n  ---\n  duration_ms: ");
    expect(tap.out).toContain("  failureType: 'subtestsFailed'\n  error: '1 subtest failed'\n");
    expect(stable(tap.out)).toContain('1..4\n# tests 8\n# suites 1\n# pass 5\n# fail 1\n# cancelled 0\n# skipped 1\n# todo 1\n# duration_ms D\nrc=1\n');
    const spec = await run('node --test-reporter=spec test/a.test.js < /dev/null; echo rc=$?');
    expect(stable(spec.out)).toMatch(/^✔ adds \(Dms\)\n▶ math\n  ✔ inner \(Dms\)\n  ✖ inner fail \(Dms\)\n  ﹣ skipped one \(Dms\) # SKIP\n  ✔ todo one \(Dms\) # TODO\n✖ math \(Dms\)\n▶ subtests\n  ✔ sub a \(Dms\)\n✔ subtests \(Dms\)\n✔ mock \(Dms\)\nℹ tests 8\nℹ suites 1\nℹ pass 5\nℹ fail 1\n/);
    expect(spec.out).toContain('\n✖ failing tests:\n\ntest at test/a.test.js\n✖ inner fail (');
    expect(spec.out).toContain('  AssertionError');
    expect(spec.out).toMatch(/rc=1\n$/);
  }, 60_000);

  it('import test from "node:test"; a passing file exits 0', async () => {
    const { run } = await shellIn('/home/user/nt2', { 'b.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert';\ntest('b passes', async () => { await new Promise((r) => setTimeout(r, 5)); assert.ok(true); });\n` });
    const r = await run('node --test-reporter=spec b.test.mjs < /dev/null; echo rc=$?');
    expect(stable(r.out)).toBe('✔ b passes (Dms)\nℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms D\nrc=0\n');
  }, 60_000);

  it('node --test finds the test files (node_modules left out), runs each, and reports them together', async () => {
    const { run } = await shellIn('/home/user/nt3', {
      'test/a.test.js': A_TEST,
      'b.test.mjs': `import test from 'node:test';\ntest('b passes', () => {});\n`,
      'src/util_test.cjs': `require('node:test')('util ok', () => { console.log('a line from the test'); });\n`,
      'node_modules/x/x.test.js': `require('node:test')('never', () => { throw new Error('ran'); });\n`,
      'lib.js': `throw new Error('not a test file');\n`,
    });
    const r = await run('node --test < /dev/null; echo rc=$?');
    const names = [...r.out.matchAll(/^(?:not )?ok \d+ - (.+)$/gm)].map((m) => m[1]);
    expect(names).toEqual(['b passes', 'util ok', 'adds', 'math', 'subtests', 'mock']);
    expect(r.out).toContain('# a line from the test\n');
    expect(stable(r.out)).toContain('1..6\n# tests 10\n# suites 1\n# pass 7\n# fail 1\n');
    expect(r.out).toMatch(/rc=1\n$/);
    // given paths; one that throws while loading is a failure of its own
    await run('printf "require(\'node:test\'); throw new Error(\'load failed\');\\n" > broken.test.js');
    const p = await run('node --test --test-reporter=spec b.test.mjs broken.test.js < /dev/null; echo rc=$?');
    expect(p.out).toContain('✔ b passes (');
    expect(p.out).toContain('✖ broken.test.js (');
    expect(p.out).toContain('load failed');
    expect(p.out).toContain('ℹ tests 2\n');
    expect(p.out).toMatch(/rc=1\n$/);
  }, 120_000);
});

describe('npm pkg, version, root, run -s, init -y, ci (#67)', () => {
  it('works on package.json as npm 10 does', async () => {
    const { run, fs } = await shellIn('/home/user/np');
    const init = await run('npm init -y');
    expect(init.out).toBe(`Wrote to /home/user/np/package.json:\n\n${JSON.stringify({ name: 'np', version: '1.0.0', main: 'index.js', scripts: { test: 'echo "Error: no test specified" && exit 1' }, keywords: [], author: '', license: 'ISC', description: '' }, null, 2)}\n\n\n`);
    expect((await run('npm pkg set scripts.test="node -e \'console.log(process.argv.slice(1))\'" scripts.hi="echo hi" && npm pkg get scripts.hi name')).out).toBe('{\n  "scripts.hi": "echo hi",\n  "name": "np"\n}\n');
    expect((await run('npm pkg get version')).out).toBe('"1.0.0"\n');
    expect((await run('npm pkg set \'files[0]="lib"\' --json && npm pkg set private=true --json && npm pkg get files private')).out).toBe('{\n  "files": [\n    "lib"\n  ],\n  "private": true\n}\n');
    await run('npm pkg delete files private');
    expect(JSON.parse(await fs.readFile('/home/user/np/package.json', 'utf8') as string).files).toBeUndefined();
    expect((await run('npm run -s hi')).out).toBe('hi\n');
    expect((await run('npm run hi')).out).toBe('\n> np@1.0.0 hi\n> echo hi\n\nhi\n'.slice(1));
    expect((await run('npm --silent run hi -- there')).out).toBe('hi there\n');
    expect((await run('npm test -s -- a b')).out).toBe("[ 'a', 'b' ]\n");
    expect((await run('npm version patch && npm version 2.0.0-rc.1 && npm version prerelease && npm pkg get version')).out).toBe('v1.0.1\nv2.0.0-rc.1\nv2.0.0-rc.2\n"2.0.0-rc.2"\n');
    expect((await run('npm version')).out).toMatch(/^\{\n  np: '2\.0\.0-rc\.2',\n  npm: '10\.8\.2',\n  node: '22\.12\.0',\n/);
    expect((await run('npm root')).out).toBe('/home/user/np/node_modules\n');
    const ci = await run('npm ci; echo rc=$?');
    expect(ci.out).toContain('npm error code EUSAGE\n');
    expect(ci.out).toMatch(/rc=1\n$/);
    await fs.writeFile('/home/user/np/package-lock.json', JSON.stringify({ name: 'np', lockfileVersion: 3, packages: { '': { name: 'np' } } }));
    await fs.mkdir('/home/user/np/node_modules/stale', { recursive: true });
    expect((await run('npm ci > /dev/null; echo rc=$?; ls node_modules 2>&1 | grep -c stale')).out).toBe('rc=0\n0\n');
  }, 120_000);

  it('npm view reads the registry', async () => {
    const { run } = await shellIn('/home/user/nv');
    expect((await run('npm view is-number@7.0.0 version')).out).toBe('7.0.0\n');
    expect((await run('npm view is-number@7.0.0 name license --json')).out).toBe('{\n  "name": "is-number",\n  "license": "MIT"\n}\n');
    const r = await run('npm view is-number@7.0.0');
    expect(r.out).toContain('is-number@7.0.0 | MIT | deps: none | versions: ');
  }, 60_000);
});
