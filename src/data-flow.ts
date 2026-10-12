/**
 * "How your data flows" (docs/DATA_FLOW.md): what leaves this tab, by which
 * path, and what this site's server can read of it, for the live state of
 * this tab. The desktop window (src/desktop/apps/dataflow.ts) and the
 * `dataflow` command (src/commands/dataflow.ts) both draw from here.
 *
 * Every sentence here states what the code does today (docs/DATA_FLOW.md
 * names the code per claim). Change the two together.
 *
 * Secrets: this module only ever holds whether one is present. The
 * collector turns each into a boolean where it reads it, and a relay URL is
 * cut down to its host, so nothing rendered from a DataFlowState can show one.
 */

import { API_KEY_PROVIDERS, GITHUB_TOKEN_STORAGE_KEY, REMOTE_CODE_STORAGE_KEY } from './credentials';

export interface DataFlowInputs {
  /** location.host of the page */
  host: string;
  ui: 'desktop' | 'terminal';
  guest: { name: string; ephemeral: boolean; noNetwork: boolean } | null;
  /** The server confirmed it treats this host as that guest (/guest/config.json) */
  guestEnforced: boolean;
  /** This server has guests to open; null when it didn't answer */
  guestsOffered: boolean | null;
  /** A GitHub token is saved (presence only) */
  github: boolean;
  /** ~/.claude/.credentials.json holds a token (presence only) */
  claude: boolean;
  /** Providers with an API key saved in localStorage, by name */
  apiKeys: string[];
  /** A remote-control code is saved */
  remoteCode: boolean;
  /** The relay the user saved in Settings → Network, as saved; only its host is kept */
  ownRelayUrl: string | null;
  /** The user let their own relay have the GitHub sign-in when it asks (OwnRelay.sendSignin) */
  ownRelaySignin?: boolean;
  /** Whether this site's /tcp relay answered */
  siteRelay: 'on' | 'off' | 'unknown';
  /** This site's relay asked for a sign-in (its token endpoint answered 401) */
  siteRelaySignin?: boolean;
  /** navigator.storage.persisted(); null when the browser can't say */
  persisted: boolean | null;
}

export interface DataFlowState {
  host: string;
  ui: 'desktop' | 'terminal';
  profile: 'main' | 'guest';
  guest: { name: string; kept: boolean; network: boolean; enforced: boolean } | null;
  guestsOffered: boolean | null;
  secrets: { github: boolean; claude: boolean; apiKeys: string[]; remoteCode: boolean; any: boolean };
  relay: {
    kind: 'site' | 'own' | 'none';
    /** The relay's host (never a path, query or user part) */
    host: string | null;
    /** Why there is none */
    why?: 'guest' | 'off';
    /** Whether the site's relay was seen to answer */
    seen: boolean;
    /** The relay in use is given the GitHub sign-in: it asked for one (the site's), or the user allowed it (their own) */
    signin?: boolean;
  };
  persisted: boolean | null;
}

/** host[:port] of a relay URL: no path, query or user part (any of them could carry a token) */
export function relayHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.host || null;
  } catch { return null; }
}

/** The state the explainer shows, from what was observed. Pure. */
export function dataFlowState(i: DataFlowInputs): DataFlowState {
  const guest = i.guest
    ? { name: i.guest.name, kept: !i.guest.ephemeral, network: !i.guest.noNetwork, enforced: !!i.guestEnforced }
    : null;
  const apiKeys = [...new Set(i.apiKeys)].sort();
  const secrets = { github: !!i.github, claude: !!i.claude, apiKeys, remoteCode: !!i.remoteCode, any: !!i.github || !!i.claude || apiKeys.length > 0 };
  const ownHost = i.ownRelayUrl ? relayHost(i.ownRelayUrl) : null;
  let relay: DataFlowState['relay'];
  if (guest && !guest.network) relay = { kind: 'none', host: null, why: 'guest', seen: false };
  // A relay of the user's own is applied in both UIs (followRelaySetting, src/kernel/net.ts)
  else if (ownHost) relay = { kind: 'own', host: ownHost, seen: false, ...(i.ownRelaySignin ? { signin: true } : {}) };
  else if (i.siteRelay === 'off') relay = { kind: 'none', host: null, why: 'off', seen: true };
  else relay = { kind: 'site', host: i.host, seen: i.siteRelay === 'on', ...(i.siteRelaySignin ? { signin: true } : {}) };
  return { host: i.host, ui: i.ui, profile: guest ? 'guest' : 'main', guest, guestsOffered: i.guestsOffered, secrets, relay, persisted: i.persisted };
}

// ── The picture: three places and the flows between them ──

/** What this site's server can read of a flow */
export type ServerReads = 'nothing' | 'requests' | 'endpoints' | 'contents';

export const READS_LABEL: Record<ServerReads, string> = {
  nothing: 'Server sees nothing',
  requests: 'Server sees which files',
  endpoints: 'Server sees where, not what',
  contents: 'Server can read the contents',
};

export interface Flow {
  id: 'local' | 'site' | 'mirror' | 'tcp' | 'api' | 'github' | 'direct' | 'shared';
  /** What travels */
  title: string;
  /** Who sends it, in the tab */
  from: string;
  /** The server's part; null when the flow does not pass through this site's server */
  via: string | null;
  /** Where it ends up outside; null when it ends at the server or never leaves */
  to: string | null;
  reads: ServerReads;
  /** One sentence: what the server can read here */
  readsText: string;
  /** A sentence or two more */
  detail: string;
  /** 'off': this tab cannot use the path now */
  status: 'on' | 'off';
  /** Why it is off, or a warning that applies now */
  note?: string;
  /** Sign-ins present in this tab that travel on this path, by name */
  carries: string[];
}

export interface Place {
  id: 'tab' | 'server' | 'internet';
  title: string;
  /** Live facts, one per line */
  lines: string[];
  detail: string;
}

export interface DataFlowModel {
  headline: string;
  places: Place[];
  flows: Flow[];
}

const DOCS_URL = 'https://github.com/williamsharkey/tabcomputer/blob/main/docs/DATA_FLOW.md';
export { DOCS_URL as DATA_FLOW_DOCS_URL };

function profileLine(s: DataFlowState): string {
  if (!s.guest) return 'Main profile';
  return `Guest, ${s.guest.kept ? `kept as "${s.guest.name}"` : 'thrown away'}${s.guest.network ? '' : ', no network'}`;
}

function relayLine(s: DataFlowState): string {
  const r = s.relay;
  if (r.kind === 'own') return `Relay: your own (${r.host})`;
  if (r.kind === 'none') return r.why === 'guest' ? 'Relay: none (no-network guest)' : 'Relay: none (off on this server)';
  return `Relay: this site's (${r.host}/tcp)${r.seen ? '' : ', not checked'}`;
}

function persistedLine(s: DataFlowState): string {
  if (s.persisted === true) return 'Storage: persistent';
  if (s.persisted === false) return 'Storage: not persistent';
  return 'Storage: persistence unknown';
}

/** The places and flows for a state, each in sentences that are true for it. Pure. */
export function dataFlowModel(s: DataFlowState): DataFlowModel {
  const g = s.guest;
  const noNet = !!g && !g.network;
  /** A no-network guest the server enforces: its proxies refuse, and the CSP blocks other sites */
  const sealed = noNet && g!.enforced;
  const present = (b: boolean) => (b ? 'present' : 'none');

  const tab: Place = {
    id: 'tab',
    title: 'This tab',
    lines: [
      profileLine(s),
      `Files: in this browser, for ${s.host}`,
      persistedLine(s),
      `GitHub token: ${present(s.secrets.github)}`,
      `Claude credentials: ${present(s.secrets.claude)}`,
      `API keys: ${s.secrets.apiKeys.length ? s.secrets.apiKeys.join(', ') : 'none'}`,
      relayLine(s),
    ],
    detail: (g
      ? `This is a guest: a separate site in the browser (${s.host}). What runs here cannot read your main tabcomputer's files or sign-ins. Anything you sign in to, paste or upload here can be read by everything that runs here.`
      : 'Files are kept in this browser\'s storage for this site and are not uploaded. Every program you run here can read all of them, and any sign-in saved here: node scripts and npm install scripts are code in the page.')
      + (s.persisted === false ? ' The browser may delete the files when the disk runs low; Settings → Storage can ask it not to.' : '')
      + ' Clearing this site\'s data in the browser deletes everything.',
  };
  const server: Place = {
    id: 'server',
    title: `${s.host.replace(/^guest--[a-z0-9-]+\./, '')} server`,
    lines: [
      'Serves the app and downloads',
      'Relays connections and API calls',
      'Sets no cookie, keeps no account',
    ],
    detail: 'The server this page came from. It relays what programs here send to other hosts. It keeps no account for you and sets no cookie. It stores only what you upload with seed share (your files, without saved sign-ins), and copies of public downloads. Its logs record addresses, hosts, paths and sizes, not payloads.',
  };
  const internet: Place = {
    id: 'internet',
    title: 'The internet',
    lines: ['Sites programs talk to', 'GitHub', 'Anthropic and other APIs', 'npm, PyPI, Debian'],
    detail: 'Every other host. One reached through the server sees the server\'s address. One the browser reaches directly sees yours.',
  };

  const flows: Flow[] = [];

  flows.push({
    id: 'local',
    title: 'Files, programs, local servers',
    from: 'the shell, x86-64 and WASM programs, node, localhost',
    via: null,
    to: null,
    reads: 'nothing',
    readsText: 'Nothing is sent.',
    detail: 'Running a program, editing a file or opening a local server on localhost stays inside the tab.',
    status: 'on',
    carries: [],
  });

  flows.push({
    id: 'site',
    title: 'The app and files this site hosts',
    from: 'boot, debian install, toolchain install, pkg',
    via: 'static files',
    to: null,
    reads: 'requests',
    readsText: 'Which files this browser asks for.',
    detail: 'Downloads only. Nothing of yours is sent with them.',
    status: 'on',
    carries: [],
  });

  flows.push({
    id: 'mirror',
    title: 'Debian packages, Claude Code releases',
    from: 'apt, GUI apps, claude install',
    via: '/debian/mirror, /claude-releases: fetches and keeps a copy',
    to: 'deb.debian.org, security.debian.org, downloads.claude.ai',
    reads: 'requests',
    readsText: 'Which package or version is asked for.',
    detail: 'Public files. Debian and Anthropic see the server\'s address, not yours. apt checks signatures; the other downloads are checked by sha256.',
    status: 'on',
    carries: [],
  });

  const tcp: Flow = {
    id: 'tcp',
    title: 'Connections programs open',
    from: 'curl, ssh, git in Debian, claude --x86, the Browser app',
    via: '/tcp relay',
    to: 'any public host, on the ports the relay allows (22, 80, 443 and 9418 by default)',
    reads: 'endpoints',
    readsText: 'The host name, port, byte counts and your address. Not the contents when the program encrypts.',
    detail: 'TLS and SSH are done in the tab, so the relay carries ciphertext. Plain http and git:// are readable. The server logs your address, the host and the byte counts.',
    status: 'on',
    carries: [],
  };
  if (s.relay.kind === 'own') {
    tcp.via = null;
    tcp.to = `your relay (${s.relay.host}), then the hosts it allows`;
    tcp.reads = 'nothing';
    tcp.readsText = 'This site\'s server sees none of it. Your relay sees the host name, port and byte counts.';
    tcp.detail = 'Programs\' connections go to the relay you set in Settings → Network. TLS and SSH are done in the tab, so it carries ciphertext too. '
      + (s.relay.signin ? 'You let it have your GitHub token when it asks for a sign-in.' : 'Your GitHub token is not sent to it.');
    if (s.relay.signin && s.secrets.github) tcp.carries.push('GitHub token');
  } else if (s.relay.kind === 'none') {
    tcp.status = 'off';
    tcp.note = s.relay.why === 'guest'
      ? 'Off: this guest has no network. Programs here have no connection.'
      : 'Off: this server has no relay. Programs here cannot open connections.';
  }
  if (s.relay.kind === 'site') {
    // relayToken (src/kernel/net.ts): the sign-in follows a 401 signin_required, never before
    if (s.relay.signin) {
      tcp.detail += ' This relay requires a sign-in, so your GitHub token is sent with each request for a relay token.';
      if (s.secrets.github) tcp.carries.push('GitHub token');
    } else {
      tcp.detail += ' A GitHub token is sent to the relay only if it asks for a sign-in; this one does not.';
    }
  }
  flows.push(tcp);

  const proxyOff = sealed ? 'Off: the server refuses this to a no-network guest.'
    : noNet ? 'Not blocked: this server does not enforce no-network for this address.' : undefined;

  flows.push({
    id: 'api',
    title: 'Claude and other model APIs',
    from: 'claude (the default build, and --npm), Gemini CLI, node programs',
    via: '/api/anthropic, /api/platform, /api/mcp-proxy, /api/gemini, /api/ws-proxy',
    to: 'api.anthropic.com, platform.claude.com, generativelanguage.googleapis.com',
    reads: 'contents',
    readsText: 'Prompts, replies and the Authorization header (your Claude token or API key) pass through it unencrypted.',
    detail: 'The server ends the HTTPS connection and makes its own to the API. It forwards and does not store them. It logs the path, the model, sizes and timing. claude --x86 goes by the relay instead, encrypted in the tab.',
    status: sealed ? 'off' : 'on',
    ...(proxyOff ? { note: proxyOff } : {}),
    carries: [...(s.secrets.claude ? ['Claude credentials'] : []), ...s.secrets.apiKeys.map((k) => `${k} API key`)],
  });

  flows.push({
    id: 'github',
    title: 'GitHub: git, gh, sign-in',
    from: 'git, gh, the Git app, GitHub sign-in',
    via: '/git-proxy, /api/github, /api/github-login',
    to: 'github.com, api.github.com; git reaches any public http(s) host',
    reads: 'contents',
    readsText: 'The GitHub token, the requests and the repository data pass through it unencrypted.',
    detail: 'The server ends the HTTPS connection and makes its own to GitHub. It forwards and does not store them. It logs the method, path and status.'
      + (g ? ' The server refuses GitHub sign-in to a guest.' : ''),
    status: sealed ? 'off' : 'on',
    ...(proxyOff ? { note: proxyOff } : {}),
    carries: s.secrets.github ? ['GitHub token'] : [],
  });

  flows.push({
    id: 'direct',
    title: 'Straight from the browser',
    from: 'npm, pip, node fetch, DNS lookups, sign-in pages',
    via: null,
    to: 'registry.npmjs.org, pypi.org, esm.sh, cdn.jsdelivr.net, unpkg.com, cloudflare-dns.com, sites that allow cross-origin requests',
    reads: 'nothing',
    readsText: 'This does not pass through the server.',
    detail: 'The browser connects to these itself, so they see your address and the request, as with any website.',
    status: sealed ? 'off' : 'on',
    ...(sealed ? { note: 'Off: the browser blocks requests to other sites in this guest. A script can still send the tab itself to another address.' }
      : noNet ? { note: 'Not blocked: this server does not enforce no-network for this address, so scripts here can still make web requests.' } : {}),
    carries: [],
  });

  flows.push({
    id: 'shared',
    title: 'Only when you run them: remote start, seed share, group',
    from: 'remote start, seed share, group',
    via: '/offer, /relay, /api/seed, /channel',
    to: 'whoever holds the code or the link',
    reads: 'contents',
    readsText: 'seed share stores your files on the server, for anyone with the link, without the sign-ins saved here. remote start gives the server only the public half of its code: the offer and relayed messages are sealed with the other half, which it never gets. group messages are readable.',
    detail: 'seed share shows what it will upload and asks first. It leaves out saved sign-ins, key files and files that contain something shaped like a token, and lists them; a secret it cannot recognise inside one of your own files still goes. A shared seed is deleted 60 days after its last visit. remote start lets the holder of the code run commands and read files here.'
      + (s.secrets.remoteCode ? ' A remote code is saved in this tab.' : ''),
    status: sealed ? 'off' : 'on',
    ...(proxyOff ? { note: proxyOff } : {}),
    // seed leaves the saved sign-ins out (src/seed-state.ts); remote start sends none
    carries: [],
  });

  const headline = g
    ? `${profileLine(s)}. It cannot read your main tabcomputer; what you put here, everything here can read.`
    : s.secrets.any
      ? 'Main profile, with sign-ins saved. Every program you run here can read them and your files.'
      : 'Main profile, no sign-ins saved. Every program you run here can read your files.';

  return { headline, places: [tab, server, internet], flows };
}

// ── What the person can do about it (only things that exist) ──

export interface DataFlowAction {
  id: 'guest' | 'guest-nonet' | 'about-guest' | 'network' | 'accounts' | 'storage';
  label: string;
  /** The same thing at a prompt, when there is a command for it */
  command?: string;
  why: string;
}

/** Actions for this state, and a sentence for each thing that is not available. Pure. */
export function dataFlowActions(s: DataFlowState): { actions: DataFlowAction[]; unavailable: string[] } {
  const actions: DataFlowAction[] = [];
  const unavailable: string[] = [];
  if (s.guest) {
    actions.push({ id: 'about-guest', label: 'About This Guest…', command: 'guest', why: 'What this guest can and cannot reach, and Discard.' });
  } else if (s.guestsOffered) {
    actions.push({ id: 'guest', label: 'Open a Guest Window', command: 'guest open', why: 'A separate tabcomputer for code you don\'t trust: it cannot read these files or sign-ins.' });
    actions.push({ id: 'guest-nonet', label: 'Open a Guest (No Network)', command: 'guest open --no-network', why: 'The same, with no relay and no requests to other sites.' });
  } else if (s.guestsOffered === false) {
    unavailable.push('This server has no guest profiles, so there is no separate place here for code you don\'t trust.');
  }
  // (a no-network guest has no relay, the user's own included: nothing to set there)
  if (!(s.guest && !s.guest.network)) actions.push(s.ui === 'desktop'
    ? { id: 'network', label: 'Network Settings…', why: 'Use a relay you run for programs\' connections. The API, GitHub and download paths stay on this site\'s server.' }
    : { id: 'network', label: 'Network Settings…', why: 'A relay of your own is set in the desktop\'s Settings → Network (there is no command for it); the terminal UI then uses it too.' });
  if (s.secrets.github || s.secrets.claude) {
    actions.push({
      id: 'accounts', label: 'Accounts…',
      command: [s.secrets.github ? 'gh auth logout' : '', s.secrets.claude ? 'rm ~/.claude/.credentials.json' : ''].filter(Boolean).join('; '),
      why: 'Sign out of GitHub or Claude: removes the saved credential from this browser.',
    });
  }
  if (s.persisted === false) actions.push({ id: 'storage', label: 'Storage…', why: 'Ask the browser to keep these files when the disk runs low.' });
  return { actions, unavailable };
}

// ── The text version (the `dataflow` command) ──

function wrap(text: string, width: number, indent: string): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && indent.length + line.length + 1 + word.length > width) { out.push(indent + line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(indent + line);
  return out;
}

/** The explainer as plain text, for a terminal `width` columns wide. Pure. */
export function dataFlowText(s: DataFlowState, width = 80): string {
  const m = dataFlowModel(s);
  const w = Math.max(40, Math.min(width, 100));
  const out: string[] = [];
  out.push('How your data flows');
  out.push(...wrap(m.headline, w, ''));
  out.push('');
  for (const p of m.places) {
    out.push(p.title.toUpperCase());
    if (p.id === 'tab') for (const l of p.lines) out.push(...wrap(l, w, '  '));
    out.push(...wrap(p.detail, w, '  '));
    out.push('');
  }
  out.push('FLOWS');
  out.push(...wrap('Who connects to whom. Replies come back the same way.', w, '  '));
  m.flows.forEach((f, n) => {
    out.push('');
    out.push(...wrap(`${n + 1}. ${f.title}${f.status === 'off' ? '  [off here]' : ''}`, w, ''));
    const path = [`tab: ${f.from}`, f.via ? `server: ${f.via}` : f.to ? '(not through the server)' : '', f.to ?? ''].filter(Boolean).join('  ->  ');
    out.push(...wrap(path, w, '   '));
    out.push(...wrap(`${READS_LABEL[f.reads]}. ${f.readsText}`, w, '   '));
    out.push(...wrap(f.detail, w, '   '));
    if (f.carries.length) out.push(...wrap(`From this tab now: ${f.carries.join(', ')}.`, w, '   '));
    if (f.note) out.push(...wrap(f.note, w, '   '));
  });
  out.push('');
  const { actions, unavailable } = dataFlowActions(s);
  out.push('WHAT YOU CAN CHANGE');
  for (const a of actions) {
    if (a.id === 'storage') continue; // a desktop pane; no command asks for persistence
    out.push(...wrap(`${a.command ? a.command : a.label.replace(/…$/, '')}: ${a.why}`, w, '  '));
  }
  for (const u of unavailable) out.push(...wrap(u, w, '  '));
  out.push('');
  out.push(...wrap('All of it, with the code behind each claim:', w, ''));
  out.push(DOCS_URL);
  return out.join('\n') + '\n';
}

// ── Reading the live state (the only part that touches the page) ──

interface CredentialFs { readFile(path: string, encoding: 'utf8'): Promise<unknown> }

// Where sign-ins live is one list (src/credentials.ts), shared with what `seed` leaves out

function has(key: string): boolean {
  try { return !!localStorage.getItem(key); } catch { return false; }
}

/** Ask this site's relay for a token: 'on' when it issues one or wants a sign-in first. Sends no credential. */
async function probeSiteRelay(fetchImpl: typeof fetch, probe: typeof import('./net-signin').probeRelayToken, timeoutMs = 3000): Promise<{ relay: 'on' | 'off' | 'unknown'; signin: boolean }> {
  const r = await probe('/tcp/token', { fetch: fetchImpl, timeoutMs });
  return { relay: r === 'on' || r === 'signin' ? 'on' : r === 'off' ? 'off' : 'unknown', signin: r === 'signin' };
}

/** What this tab is and holds, as presence only. */
export async function collectDataFlowInputs(fs: CredentialFs, opts: { ui?: 'desktop' | 'terminal'; fetch?: typeof fetch } = {}): Promise<DataFlowInputs> {
  const [{ guestInfo, guestConfig }, { ownRelay, probeRelayToken }, { hasClaudeCredentials }] = await Promise.all([
    import('./guest'), import('./net-signin'), import('./claude-signin'),
  ]);
  const guest = guestInfo();
  const fetchImpl = opts.fetch ?? fetch;
  const ui = opts.ui ?? ((await import('./ui-mode')).uiMode());
  const own = ownRelay();
  const skipProbe = !!guest?.noNetwork || !!own;
  const [cfg, claude, persisted, siteRelay] = await Promise.all([
    guestConfig(),
    hasClaudeCredentials(fs as never).catch(() => false),
    (async () => { try { return (await navigator.storage?.persisted?.()) ?? null; } catch { return null; } })(),
    skipProbe ? Promise.resolve({ relay: 'unknown' as const, signin: false }) : probeSiteRelay(fetchImpl, probeRelayToken),
  ]);
  const same = !!guest && !!cfg.guest && cfg.guest.name === guest.name && cfg.guest.noNetwork === guest.noNetwork && cfg.guest.ephemeral === guest.ephemeral;
  return {
    host: typeof location !== 'undefined' ? location.host : '',
    ui,
    guest: guest ? { name: guest.name, ephemeral: guest.ephemeral, noNetwork: guest.noNetwork } : null,
    guestEnforced: !!cfg.enforced && same,
    guestsOffered: guest ? null : !!cfg.origin,
    github: has(GITHUB_TOKEN_STORAGE_KEY),
    claude,
    apiKeys: API_KEY_PROVIDERS.filter(([, keys]) => keys.some(has)).map(([name]) => name),
    remoteCode: has(REMOTE_CODE_STORAGE_KEY),
    ownRelayUrl: own?.url ?? null,
    ownRelaySignin: own?.sendSignin === true,
    siteRelay: siteRelay.relay,
    siteRelaySignin: siteRelay.signin,
    persisted,
  };
}

/** The live state of this tab. */
export async function currentDataFlowState(fs: CredentialFs, opts: { ui?: 'desktop' | 'terminal'; fetch?: typeof fetch } = {}): Promise<DataFlowState> {
  return dataFlowState(await collectDataFlowInputs(fs, opts));
}
