/**
 * Network mode (src/net-mode.ts): proxy sends git, gh and the model APIs
 * through this site's server; private keeps them from it. Which mode a command
 * is in, where GitHub's API is, which git transport a remote gets, and which
 * requests private mode takes away from the page's fetch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  GITHUB_API, NETWORK_MODE_KEY, githubApiBase, inheritNetworkMode, networkMode, onNetworkMode,
  setNetworkMode, unproxiedUrl, withCommandEnv,
} from '@shiro/net-mode';
import { goesPrivate, privateFetch, realTarget } from '@shiro/net-private';
import { gitTransport, gitHttpFor, relayHttp } from '@shiro/commands/git-transport';
import { dataFlowModel, dataFlowState, type DataFlowInputs } from '@shiro/data-flow';

const SITE = 'https://tabcomputer.test';
const store = new Map<string, string>();
const realStorage = (globalThis as any).localStorage;

beforeEach(() => {
  store.clear();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
  inheritNetworkMode(null);
});
afterEach(() => { (globalThis as any).localStorage = realStorage; });

describe('networkMode', () => {
  it('is proxy until the user chooses private, and the choice is saved', () => {
    expect(networkMode()).toBe('proxy');
    setNetworkMode('private');
    expect(store.get(NETWORK_MODE_KEY)).toBe('private');
    expect(networkMode()).toBe('private');
    setNetworkMode('proxy');
    expect(store.has(NETWORK_MODE_KEY)).toBe(false);
    expect(networkMode()).toBe('proxy');
  });

  it("lets one command's environment go the other way", () => {
    setNetworkMode('private');
    expect(networkMode({ TABCOMPUTER_NETWORK_MODE: 'proxy' })).toBe('proxy');
    expect(networkMode({ TABCOMPUTER_NETWORK_MODE: 'nonsense' })).toBe('private');
    setNetworkMode('proxy');
    expect(networkMode({ TABCOMPUTER_NETWORK_MODE: 'private' })).toBe('private');
  });

  it('reaches code with no environment of its own while the command runs', async () => {
    setNetworkMode('private');
    const during = await withCommandEnv({ TABCOMPUTER_NETWORK_MODE: 'proxy' }, async () => githubApiBase(SITE));
    expect(during).toBe(`${SITE}/api/github`);
    expect(githubApiBase(SITE)).toBe(GITHUB_API);
  });

  it("is the page's choice in a Worker, which has no localStorage", () => {
    (globalThis as any).localStorage = undefined;
    expect(networkMode()).toBe('proxy');
    inheritNetworkMode('private');
    expect(networkMode()).toBe('private');
    expect(networkMode({ TABCOMPUTER_NETWORK_MODE: 'proxy' })).toBe('proxy');
  });

  it('tells listeners', () => {
    const seen: string[] = [];
    const off = onNetworkMode((m) => seen.push(m));
    setNetworkMode('private');
    off();
    setNetworkMode('proxy');
    expect(seen).toEqual(['private']);
  });
});

describe("where GitHub's API is", () => {
  it("is this site's proxy in proxy mode and GitHub itself in private mode", () => {
    expect(githubApiBase(SITE)).toBe(`${SITE}/api/github`);
    setNetworkMode('private');
    expect(githubApiBase(SITE)).toBe('https://api.github.com');
  });
});

describe('requests private mode takes from the page', () => {
  it("maps this site's routes back to the real hosts", () => {
    expect(unproxiedUrl(`${SITE}/api/anthropic/v1/messages`, SITE)).toBe('https://api.anthropic.com/v1/messages');
    expect(unproxiedUrl(`${SITE}/api/platform/v1/oauth/token`, SITE)).toBe('https://platform.claude.com/v1/oauth/token');
    expect(unproxiedUrl(`${SITE}/api/github/user`, SITE)).toBe('https://api.github.com/user');
    expect(unproxiedUrl(`${SITE}/debian/mirror/x.deb`, SITE)).toBeNull();
    expect(unproxiedUrl('https://elsewhere.test/api/anthropic/v1/messages', SITE)).toBeNull();
    expect(realTarget('https://api.anthropic.com/v1/messages', SITE)).toBe('https://api.anthropic.com/v1/messages');
    expect(realTarget('https://example.com/', SITE)).toBeNull();
  });

  it('leaves everything alone in proxy mode', () => {
    expect(goesPrivate(`${SITE}/api/anthropic/v1/messages`, { siteOrigin: SITE })).toBeNull();
    expect(goesPrivate('https://api.anthropic.com/v1/messages', { siteOrigin: SITE })).toBeNull();
  });

  it('takes the proxied hosts, and only those, in private mode', () => {
    setNetworkMode('private');
    expect(goesPrivate(`${SITE}/api/anthropic/v1/messages`, { siteOrigin: SITE })).toBe('https://api.anthropic.com/v1/messages');
    expect(goesPrivate('https://generativelanguage.googleapis.com/v1beta/models', { siteOrigin: SITE })).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(goesPrivate('https://registry.npmjs.org/vite', { siteOrigin: SITE })).toBeNull();
    expect(goesPrivate(`${SITE}/debian/mirror/x.deb`, { siteOrigin: SITE })).toBeNull();
    expect(goesPrivate(`${SITE}/api/anthropic/v1/messages`, { siteOrigin: SITE, env: { TABCOMPUTER_NETWORK_MODE: 'proxy' } })).toBeNull();
  });

  it("sends GitHub's API straight from the browser, never to this site", async () => {
    setNetworkMode('private');
    const asked: string[] = [];
    const fetchImpl = (async (u: string) => { asked.push(String(u)); return new Response('{}'); }) as typeof fetch;
    await privateFetch(`${SITE}/api/github/user`, { headers: { Authorization: 'Bearer t' } }, { siteOrigin: SITE, fetchImpl });
    expect(asked).toEqual(['https://api.github.com/user']);
  });

  it('refuses, and does not fall back to the proxy, when there is no relay to carry it', async () => {
    setNetworkMode('private');
    const asked: string[] = [];
    const fetchImpl = (async (u: string) => { asked.push(String(u)); return new Response('{}'); }) as typeof fetch;
    // (no WebSocket: a page that cannot reach a relay)
    const ws = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = undefined;
    try {
      await expect(privateFetch(`${SITE}/api/anthropic/v1/messages`, { method: 'POST' }, { siteOrigin: SITE, fetchImpl }))
        .rejects.toThrow(/private network mode: api\.anthropic\.com needs the TCP relay/);
    } finally { (globalThis as any).WebSocket = ws; }
    expect(asked).toEqual([]);
  });

  it("is the plain fetch of this site's route in proxy mode", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (u: string) => { asked.push(String(u)); return new Response('{}'); }) as typeof fetch;
    await privateFetch(`${SITE}/api/anthropic/v1/messages`, { method: 'POST' }, { siteOrigin: SITE, fetchImpl });
    expect(asked).toEqual([`${SITE}/api/anthropic/v1/messages`]);
  });
});

describe('git transport', () => {
  const GH = 'https://github.com/o/r.git';
  const OTHER = 'https://gitlab.com/o/r.git';
  const pageHttp = { request: async () => { throw new Error('unused'); } } as any;

  it("is this site's proxy by default", () => {
    expect(gitTransport({}, GH)).toBe('proxy');
    expect(gitTransport({}, OTHER)).toBe('proxy');
    const net = gitHttpFor({}, GH, pageHttp);
    expect(net.http).toBe(pageHttp);
    expect(net.corsProxy).toMatch(/\/git-proxy$/);
  });

  it("is GitHub's API for github.com and the relay for other hosts in private mode", () => {
    setNetworkMode('private');
    expect(gitTransport({}, GH)).toBe('api');
    expect(gitTransport({}, 'https://x-access-token@github.com/o/r')).toBe('api');
    expect(gitTransport({}, OTHER)).toBe('relay');
    const net = gitHttpFor({}, OTHER, pageHttp);
    expect(net.http).toBe(relayHttp);
    expect(net.corsProxy).toBeUndefined();
  });

  it('can be chosen for one command', () => {
    setNetworkMode('private');
    expect(gitTransport({ TABCOMPUTER_GIT_TRANSPORT: 'proxy' }, GH)).toBe('proxy');
    expect(gitTransport({ TABCOMPUTER_GIT_TRANSPORT: 'relay' }, GH)).toBe('relay');
    expect(gitTransport({ TABCOMPUTER_NETWORK_MODE: 'proxy' }, GH)).toBe('proxy');
    setNetworkMode('proxy');
    expect(gitTransport({ TABCOMPUTER_GIT_TRANSPORT: 'api' }, GH)).toBe('api');
    expect(gitTransport({ TABCOMPUTER_GIT_TRANSPORT: 'api' }, OTHER)).toBe('relay');
  });

  it('keeps an explicit GIT_CORS_PROXY meaning that proxy', () => {
    setNetworkMode('private');
    const net = gitHttpFor({ GIT_CORS_PROXY: 'https://my.proxy.test' }, GH, pageHttp);
    expect(net.transport).toBe('proxy');
    expect(net.corsProxy).toBe('https://my.proxy.test');
  });
});

describe('How your data flows, in private mode', () => {
  const MAIN: DataFlowInputs = {
    host: 'tabcomputer.test', ui: 'desktop', guest: null, guestEnforced: false, guestsOffered: true,
    github: true, claude: true, apiKeys: [], remoteCode: false, ownRelayUrl: null, siteRelay: 'on', persisted: true,
  };
  const flow = (over: Partial<DataFlowInputs>, id: string) => dataFlowModel(dataFlowState({ ...MAIN, ...over })).flows.find((f) => f.id === id)!;

  it('says the server can read GitHub and the model APIs in proxy mode', () => {
    expect(dataFlowState(MAIN).mode).toBe('proxy');
    expect(flow({}, 'github').reads).toBe('contents');
    expect(flow({}, 'github').carries).toEqual(['GitHub token']);
    expect(flow({}, 'api').reads).toBe('contents');
  });

  it('says it reads nothing of GitHub, and only where the model APIs are, in private mode', () => {
    const gh = flow({ networkMode: 'private' }, 'github');
    expect(gh.reads).toBe('nothing');
    expect(gh.via).toBeNull();
    expect(gh.carries).toEqual([]);
    const api = flow({ networkMode: 'private' }, 'api');
    expect(api.reads).toBe('endpoints');
    expect(api.via).toBe('/tcp relay');
    expect(api.carries).toEqual([]);
  });

  it('says the server sees nothing of the model APIs through a relay of your own', () => {
    const api = flow({ networkMode: 'private', ownRelayUrl: 'wss://relay.example.com/tcp' }, 'api');
    expect(api.reads).toBe('nothing');
    expect(api.via).toBeNull();
  });
});
