/**
 * util.parseArgs as node 22 documents it (tabcomputer#67): without `args` it
 * parses process.argv after the script (after node for -e), absent booleans
 * stay absent, `tokens` only with tokens: true, and strict mode's errors.
 * Expected values are node's documented outputs and its error messages.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createUtilModule } from '@shiro/node-compat/modules/util';
import { createTestShell, run } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

const plain = (r: object) => JSON.parse(JSON.stringify(r));
const parseArgs: (config?: any) => any = createUtilModule().parseArgs;

describe('util.parseArgs (node 22 semantics)', () => {
  it("the docs' first example", () => {
    const r = parseArgs({ args: ['-f', '--bar', 'b'], options: { foo: { type: 'boolean', short: 'f' }, bar: { type: 'string' } } });
    expect(plain(r)).toEqual({ values: { foo: true, bar: 'b' }, positionals: [] });
    expect(Object.getPrototypeOf(r.values)).toBe(null);
    expect('tokens' in r).toBe(false);
  });

  it("the docs' tokens example", () => {
    const options = { color: { type: 'boolean' }, 'no-color': { type: 'boolean' }, logfile: { type: 'string' }, 'no-logfile': { type: 'boolean' } };
    const r = parseArgs({ args: ['--no-logfile', '--no-color', '--logfile=test.log', '--color'], options, tokens: true });
    expect(plain(r.values)).toEqual({ 'no-logfile': true, 'no-color': true, logfile: 'test.log', color: true });
    expect(r.tokens).toEqual([
      { kind: 'option', name: 'no-logfile', rawName: '--no-logfile', index: 0, value: undefined, inlineValue: undefined },
      { kind: 'option', name: 'no-color', rawName: '--no-color', index: 1, value: undefined, inlineValue: undefined },
      { kind: 'option', name: 'logfile', rawName: '--logfile', index: 2, value: 'test.log', inlineValue: true },
      { kind: 'option', name: 'color', rawName: '--color', index: 3, value: undefined, inlineValue: undefined },
    ]);
  });

  it('allowNegative: --no-color is color: false', () => {
    expect(plain(parseArgs({ args: ['--no-color'], options: { color: { type: 'boolean' } }, allowNegative: true }).values)).toEqual({ color: false });
  });

  it("#67's example: absent booleans stay absent, defaults fill in", () => {
    const options = { top: { type: 'string', short: 'n', default: '10' }, json: { type: 'boolean' } };
    expect(plain(parseArgs({ args: ['--json', '-n', '3', 'file.txt'], options, allowPositionals: true })))
      .toEqual({ values: { json: true, top: '3' }, positionals: ['file.txt'] });
    expect(plain(parseArgs({ args: [], options }))).toEqual({ values: { top: '10' }, positionals: [] });
  });

  it('short option groups: -abfFILE is -a -b -fFILE, one index', () => {
    const r = parseArgs({ args: ['-abfFILE', 'x'], options: { a: { type: 'boolean' }, b: { type: 'boolean' }, f: { type: 'string' } }, allowPositionals: true, tokens: true });
    expect(plain(r.values)).toEqual({ a: true, b: true, f: 'FILE' });
    expect(r.positionals).toEqual(['x']);
    expect(r.tokens!.map((t: any) => [t.kind, t.rawName ?? t.value, t.index])).toEqual([['option', '-a', 0], ['option', '-b', 0], ['option', '-f', 0], ['positional', 'x', 1]]);
  });

  it('-fFILE, --foo=bar=baz and --e= (inline values)', () => {
    expect(plain(parseArgs({ args: ['-fFILE'], options: { file: { type: 'string', short: 'f' } } }).values)).toEqual({ file: 'FILE' });
    expect(plain(parseArgs({ args: ['--foo=bar=baz', '--e='], options: { foo: { type: 'string' }, e: { type: 'string' } } }).values)).toEqual({ foo: 'bar=baz', e: '' });
  });

  it("'--' ends the options; what follows is positional", () => {
    const r = parseArgs({ args: ['-a', '--', '-b', 'c'], options: { a: { type: 'boolean' } }, allowPositionals: true, tokens: true });
    expect(plain(r.values)).toEqual({ a: true });
    expect(r.positionals).toEqual(['-b', 'c']);
    expect(r.tokens!.map((t: any) => t.kind)).toEqual(['option', 'option-terminator', 'positional', 'positional']);
    expect(() => parseArgs({ args: ['--', 'x'], options: {} })).toThrow(expect.objectContaining({ code: 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL' }));
  });

  it('multiple collects every occurrence', () => {
    expect(plain(parseArgs({ args: ['-t', 'a', '--t=b'], options: { t: { type: 'string', short: 't', multiple: true } } }).values)).toEqual({ t: ['a', 'b'] });
  });

  it.each([
    [{ args: ['--x'], options: {} }, 'ERR_PARSE_ARGS_UNKNOWN_OPTION', "Unknown option '--x'"],
    [{ args: ['-x'], options: {}, allowPositionals: true }, 'ERR_PARSE_ARGS_UNKNOWN_OPTION',
      "Unknown option '-x'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"-x\""],
    [{ args: ['p'], options: {} }, 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL', "Unexpected argument 'p'. This command does not take positional arguments"],
    [{ args: ['--s'], options: { s: { type: 'string', short: 'z' } } }, 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE', "Option '-z, --s <value>' argument missing"],
    [{ args: ['--b=1'], options: { b: { type: 'boolean' } } }, 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE', "Option '--b' does not take an argument"],
    [{ args: ['-s', '-x'], options: { s: { type: 'string', short: 's' } } }, 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
      "Option '-s' argument is ambiguous.\nDid you forget to specify the option argument for '-s'?\nTo specify an option argument starting with a dash use '--s=-XYZ' or '-s-XYZ'."],
  ])('strict: %j throws %s', (config, code, message) => {
    let err: any;
    try { parseArgs(config); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TypeError);
    expect(err.code).toBe(code);
    expect(err.message).toBe(message);
  });

  it.each([
    [{ args: [], options: { x: { type: 'number' } } }],
    [{ args: [], options: { x: { type: 'string', short: 'xy' } } }],
  ])('invalid options are refused: %j', (config) => {
    let err: any;
    try { parseArgs(config); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TypeError);
    expect(err.code).toMatch(/^ERR_INVALID_ARG_/);
  });

  it("strict: false takes what it finds (a string option takes the next arg, even '--u=v')", () => {
    expect(plain(parseArgs({ args: ['--s', '--u=v', 'p', '-xy'], options: { s: { type: 'string' } }, strict: false })))
      .toEqual({ values: { s: '--u=v', x: true, y: true }, positionals: ['p'] });
    // allowPositionals defaults to !strict
    expect(parseArgs({ args: ['p'], strict: false }).positionals).toEqual(['p']);
  });

  it('a lone "-" is a positional; "-s -" is not ambiguous', () => {
    expect(parseArgs({ args: ['-'], allowPositionals: true }).positionals).toEqual(['-']);
    expect(plain(parseArgs({ args: ['-s', '-'], options: { s: { type: 'string', short: 's' } } }).values)).toEqual({ s: '-' });
  });
});

describe("util.parseArgs() parses the process's arguments by default", () => {
  let shell: Shell;
  let fs: FileSystem;
  beforeAll(async () => {
    ({ shell, fs } = await createTestShell());
    await fs.writeFile('/tmp/pa.mjs', `import { parseArgs } from 'node:util';
console.log(JSON.stringify(parseArgs({ options: { top: { type: 'string', short: 'n', default: '10' }, json: { type: 'boolean' } }, allowPositionals: true })));
`);
  });

  it("a script: process.argv after the script (#67's repro)", async () => {
    const { output } = await run(shell, 'node /tmp/pa.mjs --json -n 3 file.txt < /dev/null');
    expect(output.trim()).toBe('{"values":{"json":true,"top":"3"},"positionals":["file.txt"]}');
  });

  it('node -e: the arguments after the code', async () => {
    const { output } = await run(shell, `node -e 'console.log(JSON.stringify(require("util").parseArgs({ options: { v: { type: "boolean" } }, allowPositionals: true })))' -- -v f < /dev/null`);
    expect(output.trim()).toBe('{"values":{"v":true},"positionals":["f"]}');
  });
});
