/**
 * Where sign-ins and other secrets live in a profile. One list, used by
 *   - "How your data flows" (src/data-flow.ts), which shows what is present;
 *   - `seed` (src/seed-state.ts), which leaves them out of what it exports and
 *     never lets an imported seed replace the importer's own.
 * A feature that stores a credential adds it here (docs/DATA_FLOW.md lists
 * the same places for people).
 *
 * No imports, and nothing here reads a value: these are names and patterns.
 */

// ── localStorage ──

export interface StoredCredential {
  key: string;
  /** What to call it, to a person */
  name: string;
  /** For API keys: whose */
  provider?: 'Anthropic' | 'OpenAI' | 'Google';
  /**
   * 'signin': a credential (exported only on request, never overwritten by an import).
   * 'control': lets someone drive this tab; never exported and never imported.
   */
  kind: 'signin' | 'control';
}

/** Same key as GITHUB_TOKEN_KEY in github-auth.ts and net-signin.ts */
export const GITHUB_TOKEN_STORAGE_KEY = 'tabcomputer_github_token';
export const REMOTE_CODE_STORAGE_KEY = 'tabcomputer-remote-code';

export const STORED_CREDENTIALS: StoredCredential[] = [
  { key: GITHUB_TOKEN_STORAGE_KEY, name: 'GitHub token', kind: 'signin' },
  { key: 'tabcomputer_anthropic_key', name: 'Anthropic API key', provider: 'Anthropic', kind: 'signin' },
  { key: 'tabcomputer_api_key', name: 'Anthropic API key', provider: 'Anthropic', kind: 'signin' },
  { key: 'tabcomputer_openai_key', name: 'OpenAI API key', provider: 'OpenAI', kind: 'signin' },
  { key: 'tabcomputer_google_key', name: 'Google API key', provider: 'Google', kind: 'signin' },
  // The relay setting's URLs can carry a token, and it says where every connection goes
  { key: 'tabcomputer_relay', name: 'own relay setting', kind: 'signin' },
  // Whoever holds it can run commands here (src/commands/remote.ts)
  { key: REMOTE_CODE_STORAGE_KEY, name: 'remote-control code', kind: 'control' },
];

/** API key providers and the keys that hold one (the explainer's "API keys" line) */
export const API_KEY_PROVIDERS: [string, string[]][] = (['Anthropic', 'OpenAI', 'Google'] as const)
  .map((p) => [p, STORED_CREDENTIALS.filter((c) => c.provider === p).map((c) => c.key)]);

/**
 * The write-ahead copies node's fs keeps of ~/.claude files (`wal:<path>`,
 * src/node-compat/modules/fs.ts): file contents, the Claude credentials among
 * them, replayed onto the files at boot.
 */
export const WAL_STORAGE_PREFIX = 'wal:';

/** A key whose name says secret (also the pre-rename shiro_* keys) */
const SECRET_KEY_NAME = /token|secret|passw|credential|api[_-]?key|(^|[_-])key$|oauth|auth([_-]|$)|session[_-]?id|cookie/i;

/** Values that are a credential by their shape, whatever they are stored under */
export const TOKEN_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'an Anthropic key or token', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'an OpenAI key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'a GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/ },
  { name: 'a Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'an AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'a Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'a GitLab token', re: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { name: 'an npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'a Hugging Face token', re: /\bhf_[A-Za-z0-9]{30,}\b/ },
  { name: 'a Stripe key', re: /\b[sr]k_live_[0-9a-zA-Z]{20,}/ },
  { name: 'a private key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
];

/** What kind of token `text` contains, or null */
export function tokenIn(text: string): string | null {
  for (const { name, re } of TOKEN_PATTERNS) if (re.test(text)) return name;
  return null;
}

/**
 * How a seed treats a localStorage entry:
 *   'control'    never exported, never imported;
 *   'credential' a sign-in, or something that looks like one: exported only
 *                with --with-credentials, and an import never replaces the
 *                importer's own value;
 *   null         neither.
 */
export function storageCredentialKind(key: string, value: string | null = null): 'control' | 'credential' | null {
  const known = STORED_CREDENTIALS.find((c) => c.key === key);
  if (known) return known.kind === 'control' ? 'control' : 'credential';
  if (key.startsWith(WAL_STORAGE_PREFIX)) return 'credential';
  if (SECRET_KEY_NAME.test(key)) return 'credential';
  if (value && tokenIn(value)) return 'credential';
  return null;
}

/** The name to report a left-out localStorage entry by (never its value) */
export function storageCredentialName(key: string): string {
  const known = STORED_CREDENTIALS.find((c) => c.key === key);
  if (known) return `${known.name} (${key})`;
  if (key.startsWith(WAL_STORAGE_PREFIX)) return `saved copy of ${key.slice(WAL_STORAGE_PREFIX.length)} (${key})`;
  return key;
}

/**
 * localStorage a seed carries by default: layout and preferences. Everything
 * else stays behind (logs, caches, the entries above), because an entry nobody
 * listed may hold anything (the console log holds whatever was printed).
 */
export const SHAREABLE_STORAGE_KEYS = new Set([
  'tabcomputer-ui', 'tabcomputer-profile', 'tabcomputer-desktop-theme', 'tabcomputer-desktop-iconset',
  'tabcomputer-desktop-welcome', 'tabcomputer-desktop-session', 'tabcomputer-restore-session',
  'tabcomputer-panes', 'tabcomputer-keybar', 'tabcomputer-code-hint', 'tabcomputer-become',
  'tabcomputer-remote-relay', 'tabcomputer-watchdog-off', 'tabcomputer-watchdog-abort-after', 'shiro-x-dom-text',
]);

// ── Files ──

export const HOME_DIRS = ['/home/user', '/root'];
export const CLAUDE_CREDENTIALS_FILE = '.claude/.credentials.json';

/**
 * Files under a home directory that hold a sign-in. A seed leaves them out;
 * an import keeps the importer's own. `dir: true` means every file below.
 */
export const CREDENTIAL_HOME_FILES: { path: string; name: string; dir?: boolean }[] = [
  { path: CLAUDE_CREDENTIALS_FILE, name: 'Claude credentials' },
  { path: '.claude.json', name: 'Claude account and settings' },
  { path: '.claude/mcp-needs-auth-cache.json', name: 'Claude MCP sign-in state' },
  { path: '.netrc', name: 'netrc logins' },
  { path: '_netrc', name: 'netrc logins' },
  { path: '.git-credentials', name: 'stored git credentials' },
  { path: '.config/git/credentials', name: 'stored git credentials' },
  { path: '.config/gh/hosts.yml', name: "gh's sign-in" },
  { path: '.config/gh/hosts.yaml', name: "gh's sign-in" },
  { path: '.config/hub', name: "hub's sign-in" },
  { path: '.pypirc', name: 'PyPI credentials' },
  { path: '.aws/credentials', name: 'AWS credentials' },
  { path: '.docker/config.json', name: 'Docker registry logins' },
  { path: '.kube/config', name: 'Kubernetes credentials' },
  { path: '.cargo/credentials', name: 'crates.io token' },
  { path: '.cargo/credentials.toml', name: 'crates.io token' },
  { path: '.gem/credentials', name: 'RubyGems key' },
  { path: '.codex/auth.json', name: 'Codex sign-in' },
  { path: '.gemini/oauth_creds.json', name: 'Gemini sign-in' },
  { path: '.gemini/google_accounts.json', name: 'Gemini account' },
  { path: '.local/share/opencode/auth.json', name: 'opencode sign-in' },
  { path: '.grok/auth.json', name: 'Grok sign-in' },
  { path: '.config/gcloud', name: 'Google Cloud credentials', dir: true },
  { path: '.azure', name: 'Azure credentials', dir: true },
  { path: '.gnupg', name: 'GnuPG keys', dir: true },
];

/** Files whose secrets are single lines: the lines go, the file stays */
const SCRUB_HOME_FILES = ['.gitconfig', '.config/git/config', '.npmrc', '.yarnrc', '.yarnrc.yml',
  '.profile', '.bashrc', '.bash_profile', '.bash_login', '.zshrc', '.zshenv', '.zprofile',
  '.bash_history', '.zsh_history', '.sh_history', '.node_repl_history', '.python_history'];

function homeRelative(path: string): string | null {
  for (const home of HOME_DIRS) if (path.startsWith(home + '/')) return path.slice(home.length + 1);
  return null;
}

/** A public key, a host list or ssh's config: the parts of ~/.ssh that are not secret */
const SSH_PUBLIC = /^\.ssh\/(?:[^/]+\.pub|known_hosts(?:\.old)?|config|authorized_keys\d?)$/;
/** .env, .env.local, .env.production…, but not the examples people commit */
const DOTENV = /(?:^|\/)\.env(?:\.(?!example$|sample$|template$|dist$|defaults$)[^/]+)?$/;

/**
 * Why a seed leaves this file out whole, or null. `text` is its content when
 * it is text (null for binary or large files: then only the path decides).
 */
export function credentialFileReason(path: string, text: string | null): string | null {
  const rel = homeRelative(path);
  if (rel !== null) {
    for (const f of CREDENTIAL_HOME_FILES) {
      if (rel === f.path || (f.dir && rel.startsWith(f.path + '/'))) return f.name;
    }
    if (rel.startsWith('.ssh/') && !SSH_PUBLIC.test(rel)) return 'ssh key or agent state';
    if (/^\.claude\/[^/]*(?:credential|token|secret|oauth)[^/]*$/i.test(rel)) return 'Claude sign-in state';
  }
  if (DOTENV.test(path)) return 'environment file (.env)';
  if (text !== null && !isScrubbed(path)) {
    const token = tokenIn(text);
    if (token) return `contains ${token}`;
  }
  return null;
}

function isScrubbed(path: string): boolean {
  const rel = homeRelative(path);
  return (rel !== null && SCRUB_HOME_FILES.includes(rel)) || /\/\.git\/config$/.test(path);
}

const SECRET_ASSIGN = /^\s*(?:export\s+|set\s+|declare\s+(?:-\w+\s+)*)?([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|API_?KEY|ACCESS_KEY|PRIVATE_KEY|AUTH)[A-Za-z0-9_]*)\s*=\s*\S/i;
/**
 * user:password@ in a URL, or a long bare user (a token: https://ghp_…@github.com).
 * Not a plain user name: ssh://git@github.com stays.
 */
const URL_LOGIN = '([a-z][a-z0-9+.-]*:\\/\\/)(?:[^\\s/@:]+:[^\\s/@]*|[^\\s/@:]{20,})@';
const HAS_URL_LOGIN = new RegExp(URL_LOGIN, 'i');
const stripUrlLogins = (line: string) => line.replace(new RegExp(URL_LOGIN, 'gi'), '$1');

/**
 * A file whose secrets are lines (git config, .npmrc, shell startup files and
 * history): the text without them and what was taken out, or null when the
 * file is not one of those or has nothing to take out.
 */
export function scrubCredentialLines(path: string, text: string): { text: string; removed: string[] } | null {
  if (!isScrubbed(path)) return null;
  const rel = homeRelative(path) ?? '';
  const gitConfig = /(?:^|\/)\.gitconfig$|\.config\/git\/config$|\/\.git\/config$/.test(path);
  const npmrc = /^\.(?:npmrc|yarnrc|yarnrc\.yml)$/.test(rel);
  const removed: string[] = [];
  const out: string[] = [];
  let inCredentialSection = false;
  for (const line of text.split('\n')) {
    if (gitConfig) {
      const section = /^\s*\[\s*([A-Za-z0-9.-]+)/.exec(line);
      if (section) {
        inCredentialSection = section[1].toLowerCase() === 'credential';
        if (inCredentialSection) { removed.push('a [credential] section'); continue; }
      } else if (inCredentialSection) continue;
      if (/^\s*extraheader\s*=.*authorization/i.test(line)) { removed.push('an Authorization header'); continue; }
      if (HAS_URL_LOGIN.test(line)) { removed.push('a login inside a URL'); out.push(stripUrlLogins(line)); continue; }
    } else if (npmrc) {
      if (/_auth(?:Token)?\s*[=:]|_password\s*[=:]|npmAuth(?:Token|Ident)\s*[=:]/i.test(line)) { removed.push('a registry login'); continue; }
      if (HAS_URL_LOGIN.test(line)) { removed.push('a login inside a URL'); out.push(stripUrlLogins(line)); continue; }
    }
    const assigned = SECRET_ASSIGN.exec(line);
    if (assigned) { removed.push(`${assigned[1]}=…`); continue; }
    const token = tokenIn(line);
    if (token) { removed.push(`a line with ${token}`); continue; }
    if (!gitConfig && !npmrc && HAS_URL_LOGIN.test(line)) { removed.push('a line with a login inside a URL'); continue; }
    out.push(line);
  }
  if (!removed.length) return null;
  return { text: out.join('\n'), removed: [...new Set(removed)] };
}
