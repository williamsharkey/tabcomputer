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
  /** Whether this site's /tcp relay answered */
  siteRelay: 'on' | 'off' | 'unknown';
  /** navigator.storage.persisted(); null when the browser can't say */
  persisted: boolean | null;
  /** Settings → Network, `netmode` (net-mode.ts); absent: proxy */
  networkMode?: 'proxy' | 'private';
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
    /** A relay of the user's own is saved, but this UI does not apply it */
    ownIgnored?: boolean;
    /** Whether the site's relay was seen to answer */
    seen: boolean;
  };
  persisted: boolean | null;
  /** private: GitHub and the model APIs are not sent through this site's proxies */
  mode: 'proxy' | 'private';
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
  // Only the desktop applies a relay of the user's own (initNetwork in desktop/network.ts)
  else if (ownHost && i.ui === 'desktop') relay = { kind: 'own', host: ownHost, seen: false };
  else if (i.siteRelay === 'off') relay = { kind: 'none', host: null, why: 'off', seen: true, ...(ownHost ? { ownIgnored: true } : {}) };
  else relay = { kind: 'site', host: i.host, seen: i.siteRelay === 'on', ...(ownHost ? { ownIgnored: true } : {}) };
  return { host: i.host, ui: i.ui, profile: guest ? 'guest' : 'main', guest, guestsOffered: i.guestsOffered, secrets, relay, persisted: i.persisted, mode: i.networkMode === 'private' ? 'private' : 'proxy' };
}

// ── The picture: three places and the flows between them ──

/** What this site's server can read of a flow */
export type ServerReads = 'nothing' | 'requests' | 'endpoints' | 'contents';

export const READS_LABEL: Record<ServerReads, string> = {
  nothing: "Can't see it",
  requests: 'Sees which file',
  endpoints: 'Sees the address only',
  contents: 'Can read it',
};

export interface Flow {
  id: 'local' | 'site' | 'mirror' | 'tcp' | 'api' | 'github' | 'direct' | 'shared';
  /** What travels, in two or three words */
  title: string;
  /** Examples of what sends it */
  from: string;
  /** The server's routes; null when the flow does not pass through this site's server. Shown in the detail only */
  via: string | null;
  /** The hosts it ends at; null when it ends at the server or never leaves. Shown in the detail only */
  to: string | null;
  /** Where it ends up, in a word or two, for the diagram */
  dest?: string;
  reads: ServerReads;
  /** One or two plain sentences: what happens, and what the server can read */
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

/** The technical route of a flow, for the detail line */
export function flowRoute(f: Flow): string {
  if (!f.via && !f.to) return '';
  return ['this tab', f.via, f.to].filter(Boolean).join(' → ');
}

/** The places and flows for a state, each in sentences that are true for it. Pure. */
export function dataFlowModel(s: DataFlowState): DataFlowModel {
  const g = s.guest;
  const noNet = !!g && !g.network;
  /** A no-network guest the server enforces: its proxies refuse, and the CSP blocks other sites */
  const sealed = noNet && g!.enforced;
  const priv = s.mode === 'private';
  const signed = (b: boolean) => (b ? 'signed in' : 'not signed in');
  const r = s.relay;

  const tab: Place = {
    id: 'tab',
    title: 'This tab',
    lines: [
      profileLine(s),
      `Files: saved in this browser${s.persisted === false ? ' (it may delete them)' : ''}`,
      `GitHub: ${signed(s.secrets.github)}`,
      `Claude: ${signed(s.secrets.claude)}`,
      ...(s.secrets.apiKeys.length ? [`API keys: ${s.secrets.apiKeys.join(', ')}`] : []),
      ...(r.kind === 'own' ? [`Relay: your own (${r.host})`] : r.kind === 'none' ? ['Relay: none'] : []),
      `Mode: ${priv ? 'private' : 'proxy'}`,
    ],
    detail: (g
      ? 'This tab is a guest window. A guest window cannot see your main files or sign-ins. Every program in this guest window can read anything you put in this guest window.'
      : 'Your files are saved in this browser and are not uploaded. Any program you run in this tab can read your files and your saved sign-ins.')
      + (s.persisted === false ? ' The browser may delete your files if the disk fills up. Settings → Storage asks the browser to keep your files.' : '')
      + ' Clearing site data for this site deletes your files.',
  };
  const server: Place = {
    id: 'server',
    title: `${s.host.replace(/^guest--[a-z0-9-]+\./, '')} server`,
    lines: ['Keeps no account'],
    detail: 'Our server sent you this page. Our server passes traffic between this tab and other sites. Our server keeps no account for you. Our server stores nothing you send, except a seed you share.',
  };
  const internet: Place = {
    id: 'internet',
    title: 'The internet',
    lines: ['GitHub, Claude, other sites'],
    detail: 'Every other site. A site reached through our server sees our server\'s address. A site your browser reaches directly sees your address.',
  };

  const flows: Flow[] = [];

  flows.push({
    id: 'local',
    title: 'Files and programs',
    from: 'everything you run and save',
    via: null,
    to: null,
    reads: 'nothing',
    detail: 'Programs run inside this tab and files are saved inside this tab. Nothing is sent anywhere.',
    status: 'on',
    carries: [],
  });

  flows.push({
    id: 'site',
    title: 'The app itself',
    from: 'loading tabcomputer, toolchains, pkg',
    via: 'static files',
    to: null,
    reads: 'requests',
    detail: 'Your browser downloads the app from our server. Our server sees which files are downloaded. None of your data is sent.',
    status: 'on',
    carries: [],
  });

  flows.push({
    id: 'mirror',
    title: 'Package downloads',
    from: 'apt, GUI apps, claude install',
    via: '/debian/mirror, /claude-releases',
    to: 'deb.debian.org, security.debian.org, downloads.claude.ai',
    dest: 'Debian',
    reads: 'requests',
    detail: 'Our server fetches each package and keeps a copy. Our server sees which package you asked for. Debian and Anthropic see our server\'s address, not your address.',
    status: 'on',
    carries: [],
  });

  const tcp: Flow = {
    id: 'tcp',
    title: 'Other connections',
    from: 'curl, ssh, the Browser app',
    via: '/tcp relay',
    to: 'any public host, on the ports the relay allows (22, 80, 443 and 9418 by default)',
    dest: 'any site',
    reads: 'endpoints',
    detail: 'Our relay passes each connection along and sees the site name and the amount of data. Our relay cannot read https or ssh, because this tab encrypts https and ssh. Our relay can read plain http.',
    status: 'on',
    carries: [],
  };
  if (r.kind === 'own') {
    tcp.via = null;
    tcp.to = `your relay (${r.host}), then the hosts it allows`;
    tcp.dest = 'your relay';
    tcp.reads = 'nothing';
    tcp.detail = 'Connections go through your own relay (Settings → Network), not through our server. Your relay sees the site name and the amount of data.';
  } else if (r.kind === 'none') {
    tcp.status = 'off';
    tcp.note = r.why === 'guest'
      ? 'Off: this guest has no network.'
      : 'Off: this server has no relay, so programs here cannot open connections.';
  }
  if (r.ownIgnored) tcp.note = `${tcp.note ? tcp.note + ' ' : ''}A relay of your own is saved, but the terminal UI does not use it.`;
  if (r.kind === 'site' && s.secrets.github) {
    tcp.carries.push('GitHub token');
    tcp.detail += ' This tab sends your GitHub sign-in to our server when it asks to use the relay.';
  }
  flows.push(tcp);

  const proxyOff = sealed ? 'Off: the server refuses this to a no-network guest.'
    : noNet ? 'Not blocked: this server does not enforce no-network for this address.' : undefined;
  const viaRelay = r.kind === 'site';
  const relayName = r.kind === 'own' ? 'your relay' : 'our relay';

  flows.push(priv ? {
    id: 'api',
    title: 'Claude and other AI',
    from: 'claude, Gemini',
    via: viaRelay ? '/tcp relay' : null,
    to: 'api.anthropic.com, platform.claude.com, generativelanguage.googleapis.com',
    dest: 'Anthropic',
    reads: viaRelay ? 'endpoints' : 'nothing',
    detail: r.kind === 'none'
      ? 'Private mode needs a relay. This server has no relay, so Claude requests fail.'
      : `Private mode is on. This tab encrypts Claude traffic, and ${relayName} passes the encrypted traffic along. ${viaRelay ? 'Our server' : 'Your relay'} sees that you contacted Anthropic. ${viaRelay ? 'Our server' : 'Your relay'} cannot read your prompts or your sign-in. Claude voice input is off in private mode.`,
    status: sealed || r.kind === 'none' ? 'off' : 'on',
    ...(proxyOff ? { note: proxyOff } : {}),
    carries: [],
  } : {
    id: 'api',
    title: 'Claude and other AI',
    from: 'claude, Gemini',
    via: '/api/anthropic, /api/platform, /api/mcp-proxy, /api/gemini, /api/ws-proxy',
    to: 'api.anthropic.com, platform.claude.com, generativelanguage.googleapis.com',
    dest: 'Anthropic',
    reads: 'contents',
    detail: 'Our server forwards Claude traffic and can read your prompts, the replies and your Claude sign-in. Our server stores none of your prompts, replies or sign-in. In private mode our server cannot read Claude traffic.',
    status: sealed ? 'off' : 'on',
    ...(proxyOff ? { note: proxyOff } : {}),
    carries: [...(s.secrets.claude ? ['Claude credentials'] : []), ...s.secrets.apiKeys.map((k) => `${k} API key`)],
  });

  const guestSignIn = g ? ' A guest cannot sign in to GitHub.' : '';
  flows.push(priv ? {
    id: 'github',
    title: 'GitHub',
    from: 'git, gh, sign-in',
    via: null,
    to: 'api.github.com from the browser; sign-in, large repositories and other git hosts by the relay',
    dest: 'GitHub',
    reads: 'nothing',
    detail: `Private mode is on. Your browser talks to GitHub directly, so our server sees no GitHub traffic. GitHub sign-in, large repositories and other git sites are encrypted in this tab and passed along by ${relayName}.` + guestSignIn,
    status: sealed ? 'off' : 'on',
    ...(proxyOff ? { note: proxyOff } : {}),
    carries: [],
  } : {
    id: 'github',
    title: 'GitHub',
    from: 'git, gh, sign-in',
    via: '/git-proxy, /api/github, /api/github-login',
    to: 'github.com, api.github.com; git reaches any public http(s) host',
    dest: 'GitHub',
    reads: 'contents',
    detail: 'Our server forwards GitHub traffic and can read your code and your GitHub sign-in. Our server stores none of your code or sign-in. In private mode our server cannot read GitHub traffic.' + guestSignIn,
    status: sealed ? 'off' : 'on',
    ...(proxyOff ? { note: proxyOff } : {}),
    carries: s.secrets.github ? ['GitHub token'] : [],
  });

  flows.push({
    id: 'direct',
    title: 'npm and pip',
    from: 'npm, pip, node fetch',
    via: null,
    to: 'registry.npmjs.org, pypi.org, esm.sh, cdn.jsdelivr.net, unpkg.com, cloudflare-dns.com, sites that allow cross-origin requests',
    dest: 'npm, PyPI',
    reads: 'nothing',
    detail: 'Your browser connects to npm, PyPI and other sites directly. Each site sees your address, as any website does. Our server is not involved.',
    status: sealed ? 'off' : 'on',
    ...(sealed ? { note: 'Off: the browser blocks requests to other sites in this guest. A script can still send the tab itself to another address.' }
      : noNet ? { note: 'Not blocked: this server does not enforce no-network for this address, so scripts here can still make web requests.' } : {}),
    carries: [],
  });

  const included = [
    ...(s.secrets.github ? ['GitHub token'] : []),
    ...(s.secrets.claude ? ['Claude credentials'] : []),
    ...s.secrets.apiKeys.map((k) => `${k} API key`),
  ];
  flows.push({
    id: 'shared',
    title: 'Sharing',
    from: 'remote start, seed share, group',
    via: '/offer, /relay, /api/seed, /channel',
    to: 'whoever holds the code or the link',
    dest: 'link holders',
    reads: 'contents',
    detail: 'Nothing is shared unless you run a sharing command. seed share uploads your files and saved sign-ins, and anyone with the link can open them for 60 days. remote start lets anyone with the code control this tab. group messages are not encrypted.'
      + (s.secrets.remoteCode ? ' A remote code is saved in this tab.' : ''),
    status: sealed ? 'off' : 'on',
    ...(proxyOff ? { note: proxyOff } : {}),
    carries: included,
  });

  const headline = g
    ? `${profileLine(s)}. A guest window cannot see your main files or sign-ins.`
    : priv
      ? 'Your files stay in this browser. Private mode is on: our server cannot read your GitHub or Claude traffic.'
      : 'Your files stay in this browser. GitHub and Claude traffic passes through our server, which can read it.';

  return { headline, places: [tab, server, internet], flows };
}

// ── What the person can do about it (only things that exist) ──

export interface DataFlowAction {
  id: 'private' | 'guest' | 'guest-nonet' | 'about-guest' | 'network' | 'accounts' | 'storage';
  label: string;
  /** The same thing at a prompt, when there is a command for it */
  command?: string;
  why: string;
}

/** Actions for this state, and a sentence for each thing that is not available. Pure. */
export function dataFlowActions(s: DataFlowState): { actions: DataFlowAction[]; unavailable: string[] } {
  const actions: DataFlowAction[] = [];
  const unavailable: string[] = [];
  const priv = s.mode === 'private';
  if (!(s.guest && !s.guest.network)) actions.push({
    id: 'private',
    label: priv ? 'Turn Off Private Mode' : 'Turn On Private Mode',
    command: priv ? 'netmode proxy' : 'netmode private',
    why: priv
      ? 'Proxy mode is faster, and our server can read GitHub and Claude traffic.'
      : 'Our server cannot read GitHub or Claude traffic. A little slower.',
  });
  if (s.guest) {
    actions.push({ id: 'about-guest', label: 'About This Guest…', command: 'guest', why: 'What this guest window can reach, and Discard.' });
  } else if (s.guestsOffered) {
    actions.push({ id: 'guest', label: 'Open a Guest Window', command: 'guest open', why: 'A separate tabcomputer for code you do not trust.' });
    actions.push({ id: 'guest-nonet', label: 'Open a Guest (No Network)', command: 'guest open --no-network', why: 'A guest window with no internet.' });
  } else if (s.guestsOffered === false) {
    unavailable.push('This server has no guest profiles, so this server has no separate place for code you do not trust.');
  }
  // (a no-network guest has no relay, the user's own included: nothing to set there)
  if (!(s.guest && !s.guest.network)) actions.push(s.ui === 'desktop'
    ? { id: 'network', label: 'Network Settings…', why: 'Use your own relay.' }
    : { id: 'network', label: 'Network Settings…', why: 'Your own relay is set in the desktop\'s Settings → Network. The terminal UI always uses this site\'s relay.' });
  if (s.secrets.github || s.secrets.claude) {
    actions.push({
      id: 'accounts', label: 'Accounts…',
      command: [s.secrets.github ? 'gh auth logout' : '', s.secrets.claude ? 'rm ~/.claude/.credentials.json' : ''].filter(Boolean).join('; '),
      why: 'Sign out of GitHub or Claude.',
    });
  }
  if (s.persisted === false) actions.push({ id: 'storage', label: 'Storage…', why: 'Keep your files when the disk fills up.' });
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

/** Where a flow goes, in a few words: the middle column of the table */
export function flowPath(f: Flow): string {
  if (!f.via && !f.to) return 'stays in this tab';
  const dest = f.dest ?? f.to;
  if (!f.via) return `browser → ${dest}`;
  return dest ? `our server → ${dest}` : 'our server';
}

/**
 * The explainer as plain text, for a terminal `width` columns wide: one row
 * per kind of traffic. `verbose` adds a paragraph and the route under each row. Pure.
 */
export function dataFlowText(s: DataFlowState, width = 80, verbose = false): string {
  const m = dataFlowModel(s);
  const w = Math.max(40, Math.min(width, 100));
  const out: string[] = [];
  out.push('How your data flows');
  out.push(...wrap(m.headline, w, ''));
  out.push('');
  const rows = m.flows.map((f) => ({
    f,
    what: f.title + (f.status === 'off' ? ' [off here]' : ''),
    path: flowPath(f),
    reads: READS_LABEL[f.reads],
  }));
  const c1 = Math.max(...rows.map((r) => r.what.length), 4) + 2;
  const c2 = Math.max(...rows.map((r) => r.path.length), 7) + 2;
  const table = c1 + c2 + Math.max(...rows.map((r) => r.reads.length), 10) + 2 <= w;
  if (table) out.push('  ' + 'WHAT'.padEnd(c1) + 'GOES TO'.padEnd(c2) + 'OUR SERVER');
  for (const r of rows) {
    if (table) out.push('  ' + r.what.padEnd(c1) + r.path.padEnd(c2) + r.reads);
    else { out.push(...wrap(r.what, w, '')); out.push(...wrap(`${r.path}. Our server: ${r.reads}`, w, '  ')); }
    const extra = [
      ...(verbose ? [r.f.detail, flowRoute(r.f) ? `Route: ${flowRoute(r.f)}` : ''] : []),
      verbose && r.f.carries.length ? `Carries your ${r.f.carries.join(', ')}.` : '',
      r.f.note ?? '',
    ].filter(Boolean);
    for (const e of extra) out.push(...wrap(e, w, '      '));
  }
  out.push('');
  out.push('THIS TAB');
  // (whole facts per line: "Claude: not signed in" is never split)
  let row = '';
  for (const fact of m.places[0].lines) {
    if (row && 2 + row.length + 3 + fact.length > w) { out.push('  ' + row); row = fact; }
    else row = row ? `${row} · ${fact}` : fact;
  }
  if (row) out.push(...(2 + row.length > w ? wrap(row, w, '  ') : ['  ' + row]));
  out.push(...wrap(s.guest
    ? 'Every program in this guest window can read anything you put in this guest window.'
    : 'Any program you run in this tab can read your files and your saved sign-ins.', w, '  '));
  out.push('');
  const { actions, unavailable } = dataFlowActions(s);
  out.push('WHAT YOU CAN CHANGE');
  for (const a of actions) {
    if (a.id === 'storage') continue; // a desktop pane; no command asks for persistence
    out.push(...wrap(a.command ? a.command : a.label.replace(/…$/, ''), w, '  '));
    out.push(...wrap(a.why, w, '      '));
  }
  for (const u of unavailable) out.push(...wrap(u, w, '  '));
  out.push('');
  if (!verbose) out.push(...wrap('dataflow -v explains each row. The code behind each claim:', w, ''));
  else out.push(...wrap('The code behind each claim:', w, ''));
  out.push(DOCS_URL);
  return out.join('\n') + '\n';
}

// ── Reading the live state (the only part that touches the page) ──

interface CredentialFs { readFile(path: string, encoding: 'utf8'): Promise<unknown> }

const API_KEYS: [string, string[]][] = [
  ['Anthropic', ['tabcomputer_anthropic_key', 'tabcomputer_api_key']],
  ['OpenAI', ['tabcomputer_openai_key']],
  ['Google', ['tabcomputer_google_key']],
];

function has(key: string): boolean {
  try { return !!localStorage.getItem(key); } catch { return false; }
}

/** Ask this site's relay for a token: 'on' when it issues one. Sends no credential. */
async function probeSiteRelay(fetchImpl: typeof fetch, timeoutMs = 3000): Promise<'on' | 'off' | 'unknown'> {
  try {
    const r = await fetchImpl('/tcp/token', { method: 'POST', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) });
    // A server without the relay answers this path with the app shell, or a 404
    if (r.status === 401) return 'on';
    if (!r.ok) return r.status === 404 ? 'off' : 'unknown';
    const j = await r.json().catch(() => null);
    return j && typeof j.token === 'string' ? 'on' : 'off';
  } catch { return 'unknown'; }
}

/** What this tab is and holds, as presence only. */
export async function collectDataFlowInputs(fs: CredentialFs, opts: { ui?: 'desktop' | 'terminal'; fetch?: typeof fetch } = {}): Promise<DataFlowInputs> {
  const [{ guestInfo, guestConfig }, { ownRelay }, { hasClaudeCredentials }] = await Promise.all([
    import('./guest'), import('./net-signin'), import('./claude-signin'),
  ]);
  const guest = guestInfo();
  const fetchImpl = opts.fetch ?? fetch;
  const ui = opts.ui ?? ((await import('./ui-mode')).uiMode());
  const own = ownRelay();
  const skipProbe = !!guest?.noNetwork || (!!own && ui === 'desktop');
  const [cfg, claude, persisted, siteRelay] = await Promise.all([
    guestConfig(),
    hasClaudeCredentials(fs as never).catch(() => false),
    (async () => { try { return (await navigator.storage?.persisted?.()) ?? null; } catch { return null; } })(),
    skipProbe ? Promise.resolve('unknown' as const) : probeSiteRelay(fetchImpl),
  ]);
  const same = !!guest && !!cfg.guest && cfg.guest.name === guest.name && cfg.guest.noNetwork === guest.noNetwork && cfg.guest.ephemeral === guest.ephemeral;
  return {
    host: typeof location !== 'undefined' ? location.host : '',
    ui,
    guest: guest ? { name: guest.name, ephemeral: guest.ephemeral, noNetwork: guest.noNetwork } : null,
    guestEnforced: !!cfg.enforced && same,
    guestsOffered: guest ? null : !!cfg.origin,
    github: has('tabcomputer_github_token'),
    claude,
    apiKeys: API_KEYS.filter(([, keys]) => keys.some(has)).map(([name]) => name),
    remoteCode: has('tabcomputer-remote-code'),
    ownRelayUrl: own?.url ?? null,
    siteRelay,
    persisted,
    networkMode: (await import('./net-mode')).networkMode(),
  };
}

/** The live state of this tab. */
export async function currentDataFlowState(fs: CredentialFs, opts: { ui?: 'desktop' | 'terminal'; fetch?: typeof fetch } = {}): Promise<DataFlowState> {
  return dataFlowState(await collectDataFlowInputs(fs, opts));
}
