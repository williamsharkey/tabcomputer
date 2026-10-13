/**
 * Links whose path makes boot import or run someone else's code
 * (tabcomputer#116): a shared seed (`/s/<id>`) replaces every file, and a
 * repository (`/<user>/<repo>`) is cloned and started. Anyone can send such a
 * link, and any web page can send a tab to one.
 *
 * The rule is the run links' (src/run-url.ts, docs/RUN_LINKS.md): a link
 * never imports or runs code nobody reviewed without asking, in the same
 * Run / Cancel window (src/run-prompt.ts), with the link gone from the
 * address first and ignored inside a frame.
 *
 * Where the server has guests, bootGuest (src/guest.ts) sent the link to a
 * guest of its own before this: a seed to the kept guest `seed<id>`, a
 * repository to a thrown-away one. Nothing of the person's is there, so those
 * two go ahead without a question. Everywhere else (a main profile, or a
 * guest someone keeps under another name) it asks.
 *
 * No DOM: main.ts supplies the surroundings, the tests stand-ins.
 */
import { inboundCodeLink, type GuestInfo } from './guest';
import { GH_OWNER, GH_REPO, RunLinkError, plain, type Fetch, type RunPromptInfo } from './run-url';

export type InboundLink = NonNullable<ReturnType<typeof inboundCodeLink>>;

/** Whether this place holds anything the link's code must not reach without a yes. */
export function linkNeedsConsent(link: InboundLink, guest: GuestInfo | null): boolean {
  if (!guest) return true;
  if (guest.ephemeral) return false;
  return !(link.kind === 'seed' && guest.name === `seed${link.id}`);
}

export interface SeedEnvelope { ndjson: string; storage?: Record<string, unknown> | string | null; files?: number; hostname?: string; timestamp?: number }

/** Files a shell reads when it starts: a seed that carries one runs it at the next load */
const STARTUP_FILE = /\/(\.profile|\.bashrc|\.bash_profile|\.bash_login|\.zshrc)$|^\/etc\/profile(\.d\/.*)?$/;
const LISTED_MAX = 300;

function storageKeys(storage: SeedEnvelope['storage']): string[] {
  try {
    const o = typeof storage === 'string' ? JSON.parse(storage) : storage;
    return o && typeof o === 'object' ? Object.keys(o) : [];
  } catch { return []; }
}

/** What the window shows before a shared seed is loaded. */
export function seedPrompt(id: string, envelope: SeedEnvelope, paths: string[], guest: GuestInfo | null): RunPromptInfo {
  const here = guest ? 'this guest' : 'this tabcomputer';
  const made = [
    envelope.hostname ? `on ${plain(String(envelope.hostname), 60)}` : '',
    Number.isFinite(envelope.timestamp) && envelope.timestamp ? new Date(envelope.timestamp).toISOString().slice(0, 10) : '',
  ].filter(Boolean).join(', ');
  const sorted = [...paths].sort();
  const startup = sorted.filter((p) => STARTUP_FILE.test(p));
  const keys = storageKeys(envelope.storage).sort();
  const lines: string[] = [];
  if (startup.length) lines.push('Runs when it starts:', ...startup.map((p) => `  ${plain(p, 200)}`), '');
  if (keys.length) lines.push(`Browser settings it sets (${keys.length}):`, ...keys.slice(0, 60).map((k) => `  ${plain(k, 100)}`), ...(keys.length > 60 ? [`  … and ${keys.length - 60} more`] : []), '');
  lines.push(`Files and directories (${sorted.length}):`, ...sorted.slice(0, LISTED_MAX).map((p) => `  ${plain(p, 200)}`));
  if (sorted.length > LISTED_MAX) lines.push(`  … and ${sorted.length - LISTED_MAX} more`);
  return {
    name: `seed-${id}`, from: `a shared link${made ? ` (made ${made})` : ''}`, script: lines.join('\n') + '\n', env: {}, ignored: [], dir: '/',
    wording: {
      window: 'Shared seed',
      title: `Load the shared seed "${id}"?`,
      warn: `It replaces every file in ${here} with its own (${sorted.length}). Its programs and startup scripts then run here as you, and can use any account ${here} is signed in to (Claude, GitHub). Your sign-ins are kept, not replaced. Load it only if you trust whoever sent the link.`,
      where: 'Cancel leaves everything as it is.',
      box: 'What the seed holds',
      action: 'Load',
    },
  };
}

/** What the window shows before a repository is cloned and started. */
export function repoPrompt(user: string, repo: string, dir: string, guest: GuestInfo | null): RunPromptInfo {
  const here = guest ? 'this guest' : 'this tab';
  const shown = dir.replace(/^\/home\/user\//, '~/');
  return {
    name: `gh-${user}-${repo}`, from: `github.com/${user}/${repo}`, env: {}, ignored: [], dir,
    script: [
      `git clone https://github.com/${user}/${repo} ${shown}`,
      '# then tabcomputer works out what the project is and starts it:',
      '#   a web page (index.html)   served, and shown full-screen',
      '#   a Node project            npm install, its build, then served or run',
      '#   a Python project          pip install -r requirements.txt, then run',
      '#   a C program               compiled with cc, then run',
      '#   a Lua program             run',
    ].join('\n') + '\n',
    wording: {
      window: 'Repository link',
      title: `Clone and run ${user}/${repo}?`,
      warn: `Its code runs as you, in ${here}: it can read and change the files here and use any account ${here} is signed in to (Claude, GitHub). Run it only if you trust whoever sent the link.`,
      where: `It is cloned into ${shown}. Cancel leaves everything as it is.`,
      box: 'What happens',
      action: 'Clone and run',
    },
  };
}

export interface InboundLinkDeps {
  pathname: string;
  origin: string;
  home: string;
  /** The guest this page is (guestInfo()), or null in a main profile */
  guest: GuestInfo | null;
  /** The page is inside another page's frame */
  framed: boolean;
  /** The address asked for a guest and the server has none (guestUnavailable()) */
  guestUnavailable: boolean;
  fetch: Fetch;
  gunzip(bytes: Uint8Array): Promise<Uint8Array>;
  /** Drop the link from the address (history.replaceState) */
  cleanUrl(): void;
  /** Resolves once the page has put back its saved windows */
  ready?(): Promise<void>;
  /** The Run / Cancel window; true only when the person agreed */
  confirm(info: RunPromptInfo): Promise<boolean>;
  seed: {
    parse(ndjson: string): Promise<{ path: string }[]>;
    /** Replace this machine's files with the seed's (importSeedState) */
    load(nodes: { path: string }[], storage: SeedEnvelope['storage']): Promise<void>;
  };
  /** Start `git clone` of the repository into `dir`, then the project */
  cloneAndRun(repo: { user: string; repo: string; url: string; dir: string }): void;
  /** Tell the person why a link did nothing */
  report(message: string): void;
}

export type InboundOutcome = 'none' | 'loaded' | 'started' | 'cancelled' | 'refused';

/** Handle the page's seed or repository link, if its path is one. Never throws. */
export async function handleInboundLink(deps: InboundLinkDeps): Promise<InboundOutcome> {
  const link = inboundCodeLink(deps.pathname);
  if (!link) return 'none';
  try {
    deps.cleanUrl();
    if (deps.framed) throw new RunLinkError('links that load or run code are ignored inside a frame; open the link in its own tab');
    if (deps.guestUnavailable) throw new RunLinkError('it asked for a guest, and this server has none');
    const ask = linkNeedsConsent(link, deps.guest);
    if (link.kind === 'seed') {
      let res: Response;
      try { res = await deps.fetch(`${deps.origin}/api/seed/${link.id}`, { credentials: 'same-origin', cache: 'no-cache' }); } catch { throw new RunLinkError('could not fetch the shared seed'); }
      if (!res.ok) throw new RunLinkError(res.status === 404 ? 'no such shared seed (or this server keeps none)' : `could not fetch the shared seed (HTTP ${res.status})`);
      let envelope: SeedEnvelope;
      let nodes: { path: string }[];
      try {
        envelope = JSON.parse(new TextDecoder().decode(await deps.gunzip(new Uint8Array(await res.arrayBuffer()))));
        if (!envelope || typeof envelope.ndjson !== 'string') throw new Error('no files');
        nodes = await deps.seed.parse(envelope.ndjson);
      } catch { throw new RunLinkError('the shared seed could not be read'); }
      if (ask) {
        await deps.ready?.();
        if (!await deps.confirm(seedPrompt(link.id, envelope, nodes.map((n) => String(n.path)), deps.guest))) return 'cancelled';
      }
      await deps.seed.load(nodes, envelope.storage);
      return 'loaded';
    }
    // (a name that starts with a dot would be cloned over ~/.claude, ~/.ssh, ~/.config …)
    if (!GH_OWNER.test(link.user) || !GH_REPO.test(link.repo) || link.repo.startsWith('.')) throw new RunLinkError('that address is not a GitHub repository this page clones');
    const dir = `${deps.home}/${link.repo}`;
    if (ask) {
      await deps.ready?.();
      if (!await deps.confirm(repoPrompt(link.user, link.repo, dir, deps.guest))) return 'cancelled';
    }
    deps.cloneAndRun({ user: link.user, repo: link.repo, url: `https://github.com/${link.user}/${link.repo}`, dir });
    return 'started';
  } catch (e) {
    deps.report(e instanceof RunLinkError ? e.message : 'it failed to start');
    if (!(e instanceof RunLinkError)) console.warn('[inbound-link]', e);
    return 'refused';
  }
}
