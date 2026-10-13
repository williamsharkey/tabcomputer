/**
 * Fixes from the security review of Builds 1008 to 1025 (tabcomputer#163).
 * Each case is the smallest input that showed the flaw:
 *
 *   - the OAuth callback page wrote the address's parameters into an inline
 *     script as plain JSON, so a parameter could end the script element;
 *   - pip wrote a wheel's files wherever their names said, `..` included;
 *   - a zip member was inflated whole before its size was compared with the
 *     size the archive stated;
 *   - `link` put an edited file's whole text in the link, a token in it too.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { installWheel, wheelPathOk } from '@shiro/commands/pip';
import { pipeBytes, TooMuchOutput } from '@shiro/utils/stream-bytes';
import { trimSession, type TrimEntry } from '@shiro/link-trim';
import { HOME } from './fixtures/link-sessions';

/** `code` (an expression over the module `m`) in plain Node: vitest's polyfilled modules can't load server.mjs */
const inServer = (code: string): any => JSON.parse(execFileSync('node', ['--input-type=module', '-e',
  `const m = await import(${JSON.stringify(new URL('../../../server.mjs', import.meta.url).href)}); console.log('\\n' + JSON.stringify(await (${code}))); process.exit(0);`],
{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').pop()!);

describe('the OAuth callback page', () => {
  it('writes the address\'s parameters so that none can end its script', () => {
    const lineEnds = String.fromCharCode(0x2028) + String.fromCharCode(0x2029);
    const params = { code: 'abc', x: '</script><b id=probe>', y: '<!-- a&b -->', z: `one${lineEnds}two` };
    const text: string = inServer(`m.scriptJson(${JSON.stringify(params)})`);
    for (const c of ['<', '>', '&', ...lineEnds]) expect(text.includes(c), `U+${c.charCodeAt(0).toString(16)}`).toBe(false);
    // The script still reads the same values
    expect(JSON.parse(text)).toEqual(params);
  });
});

describe('pip: where a wheel\'s files go', () => {
  it('a name is relative and has no .. part', () => {
    for (const ok of ['pkg/__init__.py', 'x-1.0.dist-info/METADATA', 'x-1.0.data/scripts/tool', 'a..b/c.py', 'pkg/']) expect(wheelPathOk(ok), ok).toBe(true);
    for (const bad of ['../x.py', 'pkg/../../.profile', '..', '/etc/passwd', '', 'x-1/../../../y.dist-info/WHEEL']) expect(wheelPathOk(bad), bad).toBe(false);
  });

  it('a wheel with such a name is refused before anything is written', async () => {
    const touched: string[] = [];
    // (a filesystem that records every call: none may be made)
    const fs = new Proxy({}, { get: (_t, key) => (...args: unknown[]) => { touched.push(`${String(key)} ${String(args[0])}`); return Promise.resolve(); } });
    const file = (name: string) => ({ name, data: async () => new Uint8Array([1]) });
    const wheel = [file('x-1.0.dist-info/WHEEL'), file('x/__init__.py'), file('../../.profile')];
    await expect(installWheel(fs as never, wheel as never, { site: '/site', scripts: '/bin', prefix: '/usr', python: '/usr/bin/python3' } as never)).rejects.toThrow(/leaves its folder/);
    expect(touched).toEqual([]);
  });
});

describe('unpacking: no more comes out than was allowed', () => {
  it('a stream that gives more than max is stopped', async () => {
    const zeros = new Uint8Array(1 << 20);
    const packed = await pipeBytes(zeros, new CompressionStream('deflate-raw') as never);
    expect(packed.length).toBeLessThan(8192);
    await expect(pipeBytes(packed, new DecompressionStream('deflate-raw') as never, 1000)).rejects.toBeInstanceOf(TooMuchOutput);
    // Exactly what was allowed still comes out, and so does everything without a limit
    expect((await pipeBytes(packed, new DecompressionStream('deflate-raw') as never, zeros.length)).length).toBe(zeros.length);
    expect((await pipeBytes(packed, new DecompressionStream('deflate-raw') as never)).length).toBe(zeros.length);
  });
});

describe('link: an edited file that holds a token', () => {
  const edit = (name: string): TrimEntry => ({ line: `vi ${name}`, cwd: `${HOME}/site`, cwdAfter: `${HOME}/site`, status: 0, at: 3000, end: 3200, changed: [`${HOME}/site/${name}`], more: 0 });
  const trim = (name: string, text: string) => trimSession({ entries: [edit(name)], home: HOME, cwd: `${HOME}/site`, files: new Map([[`${HOME}/site/${name}`, { text }]]) });

  it('is left out of the link, and the link says so', () => {
    const r = trim('settings.txt', 'name=demo\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123\n');
    expect(r.script).not.toContain('ghp_');
    expect(r.files).not.toContain(`${HOME}/site/settings.txt`);
    expect(r.notInLink.join('\n')).toContain('shaped like a token');
  });

  it('a file whose words only contain such letters is kept', () => {
    const text = '.task-list-container-wrapper-element { color: red }\n';
    const r = trim('page.css', text);
    expect(r.script).toContain(text);
    expect(r.notInLink.join('\n')).not.toContain('shaped like a token');
  });
});
