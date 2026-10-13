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
import { noteOAuthFlow, oauthCallbackRequest, resetOAuthFlows, OAUTH_CALLBACK_PARAMS } from '@shiro/oauth-flows';
import { readFileSync } from 'node:fs';

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

describe('the OAuth callback: a tab acts only on an answer to a flow it started', () => {
  const SITE = 'https://tabcomputer.com';
  const provider = (state: string, redirect: string) => `https://provider.example/oauth/authorize?client_id=abc&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirect)}`;
  const answer = (state: string, more: Record<string, unknown> = {}) => ({ type: 'shiro-oauth-callback', code: 'the-code', state, params: { code: 'the-code', state }, ...more });

  it('a callback whose state this tab did not issue does nothing, whatever port it names', () => {
    resetOAuthFlows();
    // what anyone can link to: /oauth/callback?state=port_3000_x&port=3000&code=...
    expect(oauthCallbackRequest(answer('port_3000_whatever', { port: '3000' }))).toBeNull();
    expect(oauthCallbackRequest(answer('port_8080_guess12345', { params: { port: '8080', code: 'c', state: 'port_8080_guess12345' } }))).toBeNull();
    expect(oauthCallbackRequest({ type: 'something-else', state: 'x' })).toBeNull();
    expect(oauthCallbackRequest(null)).toBeNull();
    expect(oauthCallbackRequest('text')).toBeNull();
  });

  it('a flow is recorded when its page is opened, and its answer is passed on once, to the port named then', () => {
    resetOAuthFlows();
    const state = 'port_4567_k3J9xQ2mZ8';
    expect(noteOAuthFlow(provider(state, `${SITE}/oauth/callback`), SITE)).toBe(true);
    // the answer names another port: the one recorded at the start is used
    const ask = oauthCallbackRequest(answer(state, { port: '22', params: { code: 'the-code', state, port: '22', scope: 'read', evil: '1', error_description: 'x'.repeat(5000) } }));
    expect(ask).toEqual({ port: 4567, path: `/oauth/callback?code=the-code&state=${state}&scope=read` });
    // once
    expect(oauthCallbackRequest(answer(state))).toBeNull();
    // the port can also be named in the address the provider sends the browser back to
    const other = 'a-state-of-its-own-91';
    expect(noteOAuthFlow(provider(other, `${SITE}/oauth/callback?port=5001`), SITE)).toBe(true);
    expect(oauthCallbackRequest(answer(other))?.port).toBe(5001);
    // an error from the provider is an answer too
    const failed = 'port_4567_another1';
    noteOAuthFlow(provider(failed, `${SITE}/oauth/callback`), SITE);
    expect(oauthCallbackRequest({ type: 'shiro-oauth-callback', code: '', state: failed, params: { state: failed, error: 'access_denied' } }))
      .toEqual({ port: 4567, path: `/oauth/callback?state=${failed}&error=access_denied` });
  });

  it('only a page that comes back to this site\'s callback starts a flow, and a flow is not waited for forever', () => {
    resetOAuthFlows();
    const state = 'port_4567_k3J9xQ2mZ8';
    for (const [url, why] of [
      [provider(state, 'https://elsewhere.example/oauth/callback'), 'another site'],
      [provider(state, `${SITE}/somewhere/else`), 'another path'],
      [provider(state, `${SITE}.evil.example/oauth/callback`), 'a host that starts like this one'],
      [provider('short', `${SITE}/oauth/callback?port=4567`), 'a state anyone could guess'],
      [provider('a-long-enough-state', `${SITE}/oauth/callback`), 'no port'],
      [provider('port_0_zzzzzzzz', `${SITE}/oauth/callback`), 'port 0'],
      [provider('port_70000_zzzzzzzz', `${SITE}/oauth/callback`), 'a port past the last'],
      [`https://provider.example/oauth/authorize?state=${state}`, 'no redirect address'],
      ['not an address', 'not an address'],
    ] as const) {
      expect(noteOAuthFlow(url, SITE), why).toBe(false);
      expect(oauthCallbackRequest(answer(new URL(url, 'https://x.example/').searchParams.get('state') ?? state)), why).toBeNull();
    }
    const t0 = 1_000_000;
    expect(noteOAuthFlow(provider(state, `${SITE}/oauth/callback`), SITE, t0)).toBe(true);
    expect(oauthCallbackRequest(answer(state), t0 + 16 * 60_000)).toBeNull();
  });

  it('the page tells the tabs only what a flow that waits needs, and no port', () => {
    const address = 'code=abc&state=port_3000_x&port=3000&scope=read&error=no&session=secret&redirect=https%3A%2F%2Fevil.example&' + `error_description=${'x'.repeat(5000)}`;
    const params = inServer(`m.oauthCallbackParams(new URLSearchParams(${JSON.stringify(address)}))`);
    expect(params).toEqual({ code: 'abc', state: 'port_3000_x', scope: 'read', error: 'no' });
    // the server's list and the tab's are one list
    expect(inServer('m.OAUTH_CALLBACK_PARAMS')).toEqual([...OAUTH_CALLBACK_PARAMS]);
    // and in the page's script the message has no port, and main.ts takes none from it
    const server = readFileSync(new URL('../../../server.mjs', import.meta.url), 'utf8');
    const page = server.slice(server.indexOf('function handleOAuthCallback'), server.indexOf('// --- Product profiles'));
    expect(page).toContain('const params = oauthCallbackParams(url.searchParams);');
    expect(page.slice(page.indexOf('const html'))).not.toMatch(/port/);
    const main = readFileSync(new URL('../../../src/main.ts', import.meta.url), 'utf8');
    const bridge = main.slice(main.indexOf('const onOAuthCallback'), main.indexOf("window.addEventListener('message', onOAuthCallback)"));
    expect(bridge).toContain('const ask = oauthCallbackRequest(event.data);');
    expect(bridge).toContain('if (!ask) return;');
    expect(bridge).not.toMatch(/event\.data\.port|parseInt/);
    // the one place a program's page is opened records the flow
    expect(readFileSync(new URL('../../../src/open-url.ts', import.meta.url), 'utf8')).toContain('noteOAuthFlow(url, getShiroOrigin());');
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
