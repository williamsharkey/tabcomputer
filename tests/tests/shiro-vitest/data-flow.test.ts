/**
 * How your data flows (src/data-flow.ts, docs/DATA_FLOW.md): the state the
 * explainer derives (main profile or a guest and its mode, which sign-ins are
 * present, which relay is in use), what each flow then says, and that a
 * secret's value never reaches anything it renders. The window itself is
 * checked in tests/browser/data-flow.mjs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  collectDataFlowInputs, dataFlowActions, dataFlowModel, dataFlowState, dataFlowText, relayHost,
  type DataFlowInputs,
} from '@shiro/data-flow';
import { dataflowCmd } from '@shiro/commands/dataflow';
import { helpCmd } from '@shiro/commands/shell-builtins';
import { setGuestHostForTests, resetGuestConfigForTests } from '@shiro/guest';

const nodeRequire = createRequire(import.meta.url);
const { readFileSync } = nodeRequire('node:fs');
const path = nodeRequire('node:path');

const MAIN: DataFlowInputs = {
  host: 'tabcomputer.test', ui: 'desktop', guest: null, guestEnforced: false, guestsOffered: true,
  github: false, claude: false, apiKeys: [], remoteCode: false, ownRelayUrl: null, siteRelay: 'on', persisted: true,
};
const state = (over: Partial<DataFlowInputs> = {}) => dataFlowState({ ...MAIN, ...over });
const flow = (over: Partial<DataFlowInputs>, id: string) => dataFlowModel(state(over)).flows.find((f) => f.id === id)!;

describe('data flow: the state', () => {
  it('main profile, nothing saved', () => {
    const s = state();
    expect(s.profile).toBe('main');
    expect(s.guest).toBeNull();
    expect(s.secrets).toEqual({ github: false, claude: false, apiKeys: [], remoteCode: false, any: false });
    expect(s.relay).toEqual({ kind: 'site', host: 'tabcomputer.test', seen: true });
  });

  it('a guest and its mode, from the hostname flags', () => {
    const kept = state({ guest: { name: 'lab', ephemeral: false, noNetwork: false } });
    expect(kept.profile).toBe('guest');
    expect(kept.guest).toEqual({ name: 'lab', kept: true, network: true, enforced: false });
    expect(kept.relay.kind).toBe('site');
    const thrown = state({ guest: { name: 'a1', ephemeral: true, noNetwork: false } });
    expect(thrown.guest).toMatchObject({ kept: false, network: true });
    const sealed = state({ guest: { name: 'a1', ephemeral: true, noNetwork: true }, guestEnforced: true });
    expect(sealed.guest).toMatchObject({ kept: false, network: false, enforced: true });
    expect(sealed.relay).toEqual({ kind: 'none', host: null, why: 'guest', seen: false });
  });

  it('sign-ins present or absent', () => {
    expect(state({ github: true }).secrets).toMatchObject({ github: true, claude: false, any: true });
    expect(state({ claude: true }).secrets).toMatchObject({ github: false, claude: true, any: true });
    expect(state({ apiKeys: ['OpenAI', 'Anthropic', 'OpenAI'] }).secrets).toMatchObject({ apiKeys: ['Anthropic', 'OpenAI'], any: true });
    // a remote code is not a sign-in
    expect(state({ remoteCode: true }).secrets).toMatchObject({ remoteCode: true, any: false });
  });

  it('the relay in use', () => {
    expect(state({ siteRelay: 'unknown' }).relay).toEqual({ kind: 'site', host: 'tabcomputer.test', seen: false });
    expect(state({ siteRelay: 'off' }).relay).toEqual({ kind: 'none', host: null, why: 'off', seen: true });
    expect(state({ ownRelayUrl: 'wss://relay.example.com/tcp' }).relay).toEqual({ kind: 'own', host: 'relay.example.com', seen: false });
    // both UIs apply a relay of the user's own (#117)
    expect(state({ ownRelayUrl: 'wss://relay.example.com/tcp', ui: 'terminal' }).relay).toEqual({ kind: 'own', host: 'relay.example.com', seen: false });
    // a no-network guest has none, the user's own included
    expect(state({ ownRelayUrl: 'wss://relay.example.com/tcp', guest: { name: 'a', ephemeral: true, noNetwork: true } }).relay.kind).toBe('none');
    // a URL that isn't one is not a relay
    expect(state({ ownRelayUrl: 'not a url' }).relay.kind).toBe('site');
  });

  it('keeps only the host of a relay URL', () => {
    expect(relayHost('wss://user:hunter2@relay.example.com:8443/tcp?t=QUERYSECRET#frag')).toBe('relay.example.com:8443');
    expect(relayHost('nope')).toBeNull();
  });
});

describe('data flow: what each flow says', () => {
  it('names the three places, with the live state in the tab', () => {
    const m = dataFlowModel(state({ github: true, persisted: false }));
    expect(m.places.map((p) => p.id)).toEqual(['tab', 'server', 'internet']);
    const tab = m.places[0].lines.join('\n');
    expect(tab).toContain('Main profile');
    expect(tab).toContain('GitHub token: present');
    expect(tab).toContain('Claude credentials: none');
    expect(tab).toContain('API keys: none');
    expect(tab).toContain('Storage: not persistent');
    expect(tab).toContain("Relay: this site's (tabcomputer.test/tcp)");
    expect(m.places[0].detail).toContain('Every program you run here can read');
    expect(m.places[1].title).toBe('tabcomputer.test server');
  });

  it('says "can read the contents" only for the paths where the server ends the connection', () => {
    const reads = Object.fromEntries(dataFlowModel(state()).flows.map((f) => [f.id, f.reads]));
    expect(reads).toEqual({
      local: 'nothing', site: 'requests', mirror: 'requests', tcp: 'endpoints',
      api: 'contents', github: 'contents', direct: 'nothing', shared: 'contents',
    });
    expect(flow({}, 'tcp').readsText).toContain('Not the contents when the program encrypts');
    expect(flow({}, 'api').readsText).toContain('Authorization header');
    expect(flow({}, 'direct').via).toBeNull();
    expect(flow({}, 'local').to).toBeNull();
  });

  it('shows which saved sign-ins travel on which path', () => {
    expect(flow({}, 'api').carries).toEqual([]);
    expect(flow({ claude: true, apiKeys: ['OpenAI'] }, 'api').carries).toEqual(['Claude credentials', 'OpenAI API key']);
    expect(flow({ github: true }, 'github').carries).toEqual(['GitHub token']);
    // the GitHub token goes to this site's relay only when it asked for a sign-in (#117)
    expect(flow({ github: true }, 'tcp').carries).toEqual([]);
    expect(flow({ github: true }, 'tcp').detail).toContain('only if it asks for a sign-in; this one does not');
    expect(flow({ github: true, siteRelaySignin: true }, 'tcp').carries).toEqual(['GitHub token']);
    expect(flow({ github: false, siteRelaySignin: true }, 'tcp').carries).toEqual([]);
    // and to a relay of the user's own only when they allowed it
    expect(flow({ github: true, ownRelayUrl: 'wss://r.example/tcp' }, 'tcp').carries).toEqual([]);
    expect(flow({ github: true, ownRelayUrl: 'wss://r.example/tcp' }, 'tcp').detail).toContain('Your GitHub token is not sent to it');
    expect(flow({ github: true, ownRelayUrl: 'wss://r.example/tcp', ownRelaySignin: true }, 'tcp').carries).toEqual(['GitHub token']);
    // a shared seed leaves them out (src/seed-state.ts, #117)
    expect(flow({ github: true, claude: true, apiKeys: ['OpenAI'] }, 'shared').carries).toEqual([]);
    expect(flow({}, 'shared').readsText).toContain('without the sign-ins saved here');
  });

  it('a relay of the user\'s own takes programs\' connections off this site\'s server, and nothing else', () => {
    const tcp = flow({ ownRelayUrl: 'wss://relay.example.com/tcp' }, 'tcp');
    expect(tcp.via).toBeNull();
    expect(tcp.reads).toBe('nothing');
    expect(tcp.to).toContain('your relay (relay.example.com)');
    expect(flow({ ownRelayUrl: 'wss://relay.example.com/tcp' }, 'api').reads).toBe('contents');
    expect(flow({ ownRelayUrl: 'wss://relay.example.com/tcp' }, 'github').via).toContain('/git-proxy');
    const inTerminal = flow({ ownRelayUrl: 'wss://relay.example.com/tcp', ui: 'terminal' }, 'tcp');
    expect(inTerminal.via).toBeNull();
    expect(inTerminal.to).toContain('your relay (relay.example.com)');
    expect(inTerminal.note).toBeUndefined();
  });

  it('a no-network guest the server enforces: only this site\'s own files still flow', () => {
    const over = { guest: { name: 'a', ephemeral: true, noNetwork: true }, guestEnforced: true, guestsOffered: null };
    const status = Object.fromEntries(dataFlowModel(state(over)).flows.map((f) => [f.id, f.status]));
    expect(status).toEqual({ local: 'on', site: 'on', mirror: 'on', tcp: 'off', api: 'off', github: 'off', direct: 'off', shared: 'off' });
    // the stated limit
    expect(flow(over, 'direct').note).toContain('can still send the tab itself to another address');
  });

  it('a no-network guest the server does not enforce says so, and claims no more', () => {
    const over = { guest: { name: 'a', ephemeral: true, noNetwork: true }, guestEnforced: false, guestsOffered: null };
    const m = dataFlowModel(state(over));
    const by = Object.fromEntries(m.flows.map((f) => [f.id, f]));
    expect(by.tcp.status).toBe('off');
    for (const id of ['api', 'github', 'direct', 'shared']) {
      expect(by[id].status, id).toBe('on');
      expect(by[id].note, id).toContain('Not blocked');
    }
  });

  it('a guest with a network uses the same paths, and says what a guest is', () => {
    const over = { guest: { name: 'lab', ephemeral: false, noNetwork: false }, guestsOffered: null };
    const m = dataFlowModel(state(over));
    expect(m.flows.every((f) => f.status === 'on')).toBe(true);
    expect(m.headline).toContain('Guest, kept as "lab"');
    expect(m.places[0].detail).toContain('cannot read your main tabcomputer');
    expect(m.places[0].detail).toContain('can be read by everything that runs here');
    expect(flow(over, 'github').detail).toContain('refuses GitHub sign-in to a guest');
  });

  it('no relay on this server', () => {
    const tcp = flow({ siteRelay: 'off' }, 'tcp');
    expect(tcp.status).toBe('off');
    expect(tcp.note).toContain('this server has no relay');
  });
});

describe('data flow: actions', () => {
  const ids = (over: Partial<DataFlowInputs>) => dataFlowActions(state(over)).actions.map((a) => a.id);
  it('offers a guest only when the server has them', () => {
    expect(ids({})).toEqual(['guest', 'guest-nonet', 'network']);
    const none = dataFlowActions(state({ guestsOffered: false }));
    expect(none.actions.map((a) => a.id)).toEqual(['network']);
    expect(none.unavailable.join(' ')).toContain('no guest profiles');
    // not known: neither offered nor denied
    expect(dataFlowActions(state({ guestsOffered: null }))).toMatchObject({ unavailable: [] });
  });
  it('in a guest, points at the guest\'s own statement', () => {
    expect(ids({ guest: { name: 'a', ephemeral: true, noNetwork: false }, guestsOffered: null })).toEqual(['about-guest', 'network']);
    // a no-network guest has no relay to set
    expect(ids({ guest: { name: 'a', ephemeral: true, noNetwork: true }, guestsOffered: null })).toEqual(['about-guest']);
  });
  it('offers sign-out only for what is signed in, and storage only when it is not persistent', () => {
    expect(ids({ github: true })).toContain('accounts');
    expect(dataFlowActions(state({ github: true })).actions.find((a) => a.id === 'accounts')!.command).toBe('gh auth logout');
    expect(dataFlowActions(state({ github: true, claude: true })).actions.find((a) => a.id === 'accounts')!.command).toBe('gh auth logout; rm ~/.claude/.credentials.json');
    expect(ids({ persisted: false })).toContain('storage');
    expect(ids({ persisted: null })).not.toContain('storage');
  });
  it('says where a relay is set from the terminal UI, which uses it too', () => {
    expect(dataFlowActions(state({ ui: 'terminal' })).actions.find((a) => a.id === 'network')!.why).toContain('the terminal UI then uses it too');
  });
});

describe('data flow: the text version', () => {
  it('has every place and flow, and the live state', () => {
    const text = dataFlowText(state({ github: true, guestsOffered: false }), 80);
    expect(text).toContain('How your data flows');
    for (const part of ['THIS TAB', 'TABCOMPUTER.TEST SERVER', 'THE INTERNET', 'FLOWS', 'WHAT YOU CAN CHANGE']) expect(text, part).toContain(part);
    for (const f of dataFlowModel(state()).flows) expect(text, f.id).toContain(f.title);
    expect(text).toContain('GitHub token: present');
    expect(text).toContain('Claude credentials: none');
    expect(text).toContain('From this tab now: GitHub token.');
    expect(text).toContain('gh auth logout');
    expect(text).toContain('no guest profiles');
    expect(text).toContain('docs/DATA_FLOW.md');
    for (const line of text.split('\n')) if (!line.includes('http')) expect(line.length, line).toBeLessThanOrEqual(80);
  });
  it('wraps to a narrow terminal', () => {
    const text = dataFlowText(state(), 40);
    // (a URL or a route list is one word and may run over)
    const long = text.split('\n').filter((l) => l.length > 40 && /\s\S+\s/.test(l.trim()) && !l.includes('http'));
    expect(long).toEqual([]);
  });
  it('marks what is off in a no-network guest', () => {
    const text = dataFlowText(state({ guest: { name: 'a', ephemeral: true, noNetwork: true }, guestEnforced: true, guestsOffered: null }));
    expect(text).toContain('Guest, thrown away, no network');
    expect(text).toContain('Connections programs open [off here]');
    expect(text).toContain('Relay: none (no-network guest)');
  });
});

describe('data flow: a secret\'s value is never in the output', () => {
  const TOKEN = 'ghp_FAKEtokenFAKEtokenFAKEtokenFAKE12345';
  const CLAUDE_ACCESS = 'sk-ant-oat01-FAKE-access-value-never-shown';
  const CLAUDE_REFRESH = 'sk-ant-ort01-FAKE-refresh-value-never-shown';
  const API_KEY = 'sk-ant-api03-FAKE-api-key-never-shown';
  const REMOTE = 'fluffy-cloud-fakesecretcode';
  const RELAY_USER = 'relayuser', RELAY_PASS = 'relaypassFAKE', RELAY_Q = 'QUERYSECRETFAKE';
  const SECRETS = [TOKEN, CLAUDE_ACCESS, CLAUDE_REFRESH, API_KEY, REMOTE, RELAY_PASS, RELAY_Q, RELAY_USER];
  const fs = {
    async readFile(p: string) {
      if (p === '/home/user/.claude/.credentials.json') return JSON.stringify({ claudeAiOauth: { accessToken: CLAUDE_ACCESS, refreshToken: CLAUDE_REFRESH, subscriptionType: 'max' } });
      throw new Error('ENOENT');
    },
  };
  const emptyFs = { async readFile(): Promise<string> { throw new Error('ENOENT'); } };
  let saved: unknown;
  const store = new Map<string, string>();
  beforeEach(() => {
    saved = (globalThis as any).localStorage;
    store.clear();
    (globalThis as any).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      get length() { return store.size; },
      key: (i: number) => [...store.keys()][i] ?? null,
    };
  });
  afterEach(() => {
    (globalThis as any).localStorage = saved;
    setGuestHostForTests(undefined);
    resetGuestConfigForTests();
  });
  const plant = () => {
    store.set('tabcomputer_github_token', TOKEN);
    store.set('tabcomputer_anthropic_key', API_KEY);
    store.set('tabcomputer-remote-code', REMOTE);
    store.set('tabcomputer_relay', JSON.stringify({ url: `wss://${RELAY_USER}:${RELAY_PASS}@relay.example.com/tcp?t=${RELAY_Q}`, tokenUrl: `https://relay.example.com/tcp/token?k=${RELAY_Q}` }));
  };
  const relayOn = (async () => new Response(JSON.stringify({ token: 'x', expires: 1 }), { status: 200 })) as unknown as typeof fetch;
  const noRelay = (async () => new Response('<!doctype html>', { status: 200 })) as unknown as typeof fetch;

  it('reads presence, and nothing else, from the page', async () => {
    plant();
    const inputs = await collectDataFlowInputs(fs, { ui: 'desktop', fetch: relayOn });
    expect(inputs).toMatchObject({ github: true, claude: true, apiKeys: ['Anthropic'], remoteCode: true, guest: null });
    const s = dataFlowState(inputs);
    expect(s.secrets).toEqual({ github: true, claude: true, apiKeys: ['Anthropic'], remoteCode: true, any: true });
    expect(s.relay).toEqual({ kind: 'own', host: 'relay.example.com', seen: false });
    const everything = [
      JSON.stringify(s), JSON.stringify(dataFlowModel(s)), JSON.stringify(dataFlowActions(s)),
      dataFlowText(s, 80), dataFlowText(s, 40),
      dataFlowText(dataFlowState({ ...inputs, ui: 'terminal' })),
    ].join('\n');
    for (const secret of SECRETS) expect(everything.includes(secret), secret).toBe(false);
    expect(everything).toContain('GitHub token: present');
    expect(everything).toContain('Claude credentials: present');
    expect(everything).toContain('API keys: Anthropic');
  });

  it('absent is absent', async () => {
    const inputs = await collectDataFlowInputs(emptyFs, { ui: 'desktop', fetch: relayOn });
    expect(inputs).toMatchObject({ github: false, claude: false, apiKeys: [], remoteCode: false, ownRelayUrl: null, siteRelay: 'on' });
    const text = dataFlowText(dataFlowState(inputs));
    expect(text).toContain('GitHub token: none');
    expect(text).toContain('Claude credentials: none');
  });

  it('a credentials file without a token is not a sign-in', async () => {
    const hollow = { async readFile() { return JSON.stringify({ claudeAiOauth: {} }); } };
    expect((await collectDataFlowInputs(hollow, { ui: 'desktop', fetch: relayOn })).claude).toBe(false);
  });

  it('tells a server without the relay (it answers with the app shell) from one with it', async () => {
    expect((await collectDataFlowInputs(emptyFs, { ui: 'desktop', fetch: noRelay })).siteRelay).toBe('off');
    const down = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect((await collectDataFlowInputs(emptyFs, { ui: 'desktop', fetch: down })).siteRelay).toBe('unknown');
    // the probe sends no credential
    plant();
    store.delete('tabcomputer_relay');
    let seen: RequestInit | undefined;
    const spy = (async (_u: unknown, init?: RequestInit) => { seen = init; return new Response('{"token":"x"}', { status: 200 }); }) as unknown as typeof fetch;
    await collectDataFlowInputs(emptyFs, { ui: 'desktop', fetch: spy });
    expect(seen?.credentials).toBe('omit');
    expect(JSON.stringify(seen?.headers ?? {})).not.toContain(TOKEN);
  });

  it('sees a guest from the hostname', async () => {
    setGuestHostForTests('guest--lab--x.tabcomputer.test');
    const inputs = await collectDataFlowInputs(emptyFs, { ui: 'desktop', fetch: relayOn });
    expect(inputs.guest).toEqual({ name: 'lab', ephemeral: false, noNetwork: true });
    // nothing confirmed it, so nothing is claimed
    expect(inputs.guestEnforced).toBe(false);
    expect(inputs.guestsOffered).toBeNull();
    expect(dataFlowState(inputs).relay.kind).toBe('none');
  });

  it('the dataflow command prints the text and the state, without a value', async () => {
    plant();
    const run = async (args: string[]) => {
      const ctx: any = { args, fs, env: {}, stdout: '', stderr: '', stdoutIsTTY: false };
      const code = await dataflowCmd.exec(ctx);
      return { code, out: ctx.stdout as string, err: ctx.stderr as string };
    };
    const text = await run([]);
    expect(text.code).toBe(0);
    expect(text.out).toContain('How your data flows');
    expect(text.out).toContain('GitHub token: present');
    const json = await run(['--json']);
    expect(JSON.parse(json.out).secrets).toMatchObject({ github: true, claude: true });
    for (const secret of SECRETS) expect((text.out + json.out).includes(secret), secret).toBe(false);
    expect((await run(['--help'])).out).toContain('Usage: dataflow');
    expect((await run(['--bogus'])).code).toBe(2);
  });
});

describe('data flow: the doc and the app agree', () => {
  const doc: string = readFileSync(path.resolve(__dirname, '../../../docs/DATA_FLOW.md'), 'utf8');
  it('docs/DATA_FLOW.md names every server route a flow goes through', () => {
    const routes = new Set<string>();
    for (const f of dataFlowModel(state()).flows) for (const r of (f.via ?? '').match(/\/[a-z][a-z-]*(?:\/[a-z-]+)?/g) ?? []) routes.add(r);
    expect(routes.size).toBeGreaterThan(8);
    for (const r of routes) expect(doc.includes(r), r).toBe(true);
  });
  it('help points at the command', async () => {
    const ctx: any = { args: [], stdout: '', stderr: '' };
    await helpCmd.exec(ctx);
    expect(ctx.stdout).toContain('dataflow');
  });
});
