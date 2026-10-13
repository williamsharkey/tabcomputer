/**
 * A seed carries no credentials (issue #117, item 1). `seed share` used to
 * upload every file and all of localStorage: the GitHub token, the Claude
 * credentials (the file, and the copy node keeps of it under `wal:`), API
 * keys, the remote-control code. Anyone with the link could download them.
 *
 * Here: what collectSeedState leaves out and reports, that `seed share` shows
 * what it will upload and asks first, and that importing a seed neither
 * replaces the importer's sign-ins nor plants a remote-control code.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestShell, run } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';
import { seedCmd } from '@shiro/commands/seed';
import { collectSeedState, importSeedState, parseSeedNdjson } from '@shiro/seed-state';
import { STORED_CREDENTIALS, API_KEY_PROVIDERS, credentialFileReason, scrubCredentialLines, storageCredentialKind } from '@shiro/credentials';

const serverPath = decodeURIComponent(new URL('../../../server.mjs', import.meta.url).pathname);

// ── localStorage ──
const store: Record<string, string> = {};
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k in store) delete store[k]; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  },
});

// ── The secrets of the machine under test: none of these may leave it ──
const S = {
  github: 'gho_GitHubSignInToken0000000000000000000001',
  claudeAccess: 'sk-ant-oat01-ClaudeAccessToken000000000000000000000002',
  claudeRefresh: 'sk-ant-ort01-ClaudeRefreshToken00000000000000000000003',
  anthropic: 'sk-ant-api03-AnthropicApiKey0000000000000000000000004',
  openai: 'sk-proj-OpenAiKey00000000000000000000000000000000005',
  remote: 'fluffy-cloud-shimutako#abcdefghijklmnopqrstuvwxyz',
  relayToken: 'RelayUrlToken0000000000000000006',
  sshKey: 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQyNTUxOQAAACD07',
  gitUrlToken: 'ghp_TokenInsideAGitRemoteUrl0000000000000008',
  netrc: 'NetrcPassword0000000009',
  npm: 'npm_NpmAuthToken0000000000000000000000010',
  ghHosts: 'gho_GhCliHostsFileToken00000000000000000011',
  dotenv: 'DotEnvDatabasePassword00000012',
  inNotes: 'ghp_TokenPastedIntoANotesFile000000000000013',
  inBashrc: 'sk-ant-api03-ExportedFromBashrc00000000000000000014',
  plainSecretVar: 'PlainSecretValue15',
  inHistory: 'ghp_TypedAtThePrompt00000000000000000000016',
  awsSecret: 'AwsSecretAccessKey000000000000000000000017',
  accountEmail: 'someone.private@example.com',
};
const SECRETS = Object.values(S);
const CLAUDE_CREDS = JSON.stringify({ claudeAiOauth: { accessToken: S.claudeAccess, refreshToken: S.claudeRefresh, expiresAt: 4102444800000 } });
const H = '/home/user';

async function plantMachine(fs: FileSystem) {
  for (const d of ['.claude', '.ssh', '.config/gh', '.aws', 'project/.git', 'project/src']) await fs.mkdir(`${H}/${d}`, { recursive: true });
  // ordinary work
  await fs.writeFile(`${H}/project/hello.txt`, 'Hello, tabcomputer!');
  await fs.writeFile(`${H}/project/src/app.js`, 'const token = process.env.API_TOKEN;\nconsole.log("no secret here");\n');
  await fs.writeFile(`${H}/project/.env.example`, 'DATABASE_PASSWORD=changeme\n');
  await fs.writeFile(`${H}/.claude/settings.json`, '{"theme":"dark"}');
  // sign-ins and keys
  await fs.writeFile(`${H}/.claude/.credentials.json`, CLAUDE_CREDS);
  await fs.writeFile(`${H}/.claude.json`, JSON.stringify({ oauthAccount: { emailAddress: S.accountEmail }, hasCompletedOnboarding: true }));
  await fs.writeFile(`${H}/.ssh/id_ed25519`, `-----BEGIN OPENSSH PRIVATE KEY-----\n${S.sshKey}\n-----END OPENSSH PRIVATE KEY-----\n`);
  await fs.writeFile(`${H}/.ssh/id_ed25519.pub`, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPublicKeyOnly user@tabcomputer\n');
  await fs.writeFile(`${H}/.ssh/known_hosts`, 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n');
  await fs.writeFile(`${H}/.gitconfig`, `[user]\n\tname = Some One\n\temail = one@example.com\n[credential "https://github.com"]\n\thelper =\n\thelper = !gh auth git-credential\n[url "https://x-access-token:${S.gitUrlToken}@github.com/"]\n\tinsteadOf = https://github.com/\n[alias]\n\tst = status\n`);
  await fs.writeFile(`${H}/project/.git/config`, `[core]\n\tbare = false\n[remote "origin"]\n\turl = https://someone:${S.gitUrlToken}@github.com/someone/project.git\n[remote "ssh"]\n\turl = ssh://git@github.com/someone/project.git\n`);
  await fs.writeFile(`${H}/.netrc`, `machine api.example.com login me password ${S.netrc}\n`);
  await fs.writeFile(`${H}/.npmrc`, `registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${S.npm}\nsave-exact=true\n`);
  await fs.writeFile(`${H}/.config/gh/hosts.yml`, `github.com:\n    oauth_token: ${S.ghHosts}\n    user: someone\n`);
  await fs.writeFile(`${H}/.aws/credentials`, `[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = ${S.awsSecret}\n`);
  await fs.writeFile(`${H}/project/.env`, `DATABASE_PASSWORD=${S.dotenv}\n`);
  await fs.writeFile(`${H}/project/notes.txt`, `todo: rotate this\n${S.inNotes}\n`);
  await fs.writeFile(`${H}/.bashrc`, `alias ll='ls -l'\nexport ANTHROPIC_API_KEY=${S.inBashrc}\nexport MY_SERVICE_SECRET=${S.plainSecretVar}\nexport EDITOR=vim\n`);
  await fs.writeFile(`${H}/.bash_history`, `ls\ngh auth login --with-token <<< ${S.inHistory}\ncd project\n`);

  localStorage.clear();
  localStorage.setItem('tabcomputer_github_token', S.github);
  localStorage.setItem('tabcomputer_anthropic_key', S.anthropic);
  localStorage.setItem('tabcomputer_openai_key', S.openai);
  localStorage.setItem('tabcomputer-remote-code', S.remote);
  localStorage.setItem('tabcomputer_relay', JSON.stringify({ url: `wss://relay.example.com/tcp?t=${S.relayToken}` }));
  localStorage.setItem(`wal:${H}/.claude/.credentials.json`, CLAUDE_CREDS);
  localStorage.setItem('tabcomputer-console-log', JSON.stringify([{ text: `printed by a script: ${S.inNotes}` }]));
  localStorage.setItem('some_plugin_session_token', 'opaque-but-named-like-a-secret');
  localStorage.setItem('unlisted-thing', `value that is a token: ${S.openai}`);
  localStorage.setItem('tabcomputer-watchdog', '{"events":[]}');
  localStorage.setItem('tabcomputer-desktop-theme', 'dark');
  localStorage.setItem('tabcomputer-panes', '{"layout":"single"}');
}

/** Everything a seed's bytes say: file contents decoded, storage, paths */
function everythingIn(ndjson: string, storageJson: string): string {
  const parts = [storageJson];
  for (const line of ndjson.split('\n')) {
    if (!line.trim()) continue;
    const node = JSON.parse(line);
    parts.push(node.path);
    if (node.content) parts.push(atob(node.content));
  }
  return parts.join('\n');
}
const pathsIn = (ndjson: string) => ndjson.split('\n').filter(Boolean).map((l) => JSON.parse(l).path as string);
const fileIn = (ndjson: string, path: string) => { const n = ndjson.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.path === path); return n ? atob(n.content ?? '') : null; };
const expectNoSecret = (text: string, where: string) => { for (const [name, value] of Object.entries(S)) expect(text.includes(value), `${where} carries ${name}`).toBe(false); };

async function gunzip(bytes: Uint8Array): Promise<string> {
  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter(); void w.write(bytes as unknown as BufferSource); void w.close();
  return new Response(ds.readable).text();
}

let fs: FileSystem; let shell: Shell;
let uploads: Uint8Array[] = [];
/** Whether the server keeps shared seeds (TABCOMPUTER_SEED_SHARE=1) */
let serverShares = true;
const realFetch = globalThis.fetch;
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
let clipboard = '';

beforeEach(async () => {
  ({ fs, shell } = await createTestShell());
  shell.commands.register(seedCmd);
  await fs.importAll([]);           // each test starts from an empty disk
  await plantMachine(fs);
  uploads = []; clipboard = ''; serverShares = true;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    if (String(url).endsWith('/api/seed') && (init.method ?? 'GET') === 'GET') {
      return serverShares
        ? new Response(JSON.stringify({ enabled: true, maxBytes: 524288, keepDays: 60 }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('Unknown API target: seed', { status: 404 });   // a server from before the setting
    }
    if (String(url).endsWith('/api/seed') && init.method === 'POST') {
      uploads.push(new Uint8Array(init.body));
      return new Response(JSON.stringify({ id: 'abcd1234', url: '/s/abcd1234' }), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { clipboard: { writeText: async (t: string) => { clipboard = t; }, readText: async () => clipboard } } });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator);
  localStorage.clear();
});

describe('one list of where sign-ins live', () => {
  it('the explainer and seed read the same module', () => {
    const src = (p: string) => readFileSync(new URL(`../../../src/${p}`, import.meta.url), 'utf8');
    expect(src('data-flow.ts')).toMatch(/from '\.\/credentials'/);
    expect(src('seed-state.ts')).toMatch(/from '\.\/credentials'/);
    // no second list of key names in either
    for (const f of ['data-flow.ts', 'seed-state.ts', 'commands/seed.ts']) {
      for (const c of STORED_CREDENTIALS) expect(src(f).includes(`'${c.key}'`), `${f} names ${c.key} itself`).toBe(false);
    }
    expect(STORED_CREDENTIALS.map((c) => c.key)).toEqual(expect.arrayContaining(['tabcomputer_github_token', 'tabcomputer_anthropic_key', 'tabcomputer_api_key', 'tabcomputer_openai_key', 'tabcomputer_google_key', 'tabcomputer-remote-code', 'tabcomputer_relay']));
    expect(Object.fromEntries(API_KEY_PROVIDERS)).toEqual({ Anthropic: ['tabcomputer_anthropic_key', 'tabcomputer_api_key'], OpenAI: ['tabcomputer_openai_key'], Google: ['tabcomputer_google_key'] });
    expect(src('github-auth.ts')).toContain("'tabcomputer_github_token'");
    expect(src('commands/remote.ts')).toContain("'tabcomputer-remote-code'");
    expect(src('claude-signin.ts')).toContain("'/home/user/.claude/.credentials.json'");
  });

  it('knows a credential file from its neighbours', () => {
    expect(credentialFileReason(`${H}/.claude/.credentials.json`, null)).toBe('Claude credentials');
    expect(credentialFileReason('/root/.claude/.credentials.json', null)).toBe('Claude credentials');
    expect(credentialFileReason(`${H}/.ssh/id_rsa`, null)).toMatch(/ssh key/);
    expect(credentialFileReason(`${H}/.ssh/id_rsa.pub`, 'ssh-rsa AAAA')).toBeNull();
    expect(credentialFileReason(`${H}/.ssh/config`, 'Host *')).toBeNull();
    expect(credentialFileReason(`${H}/.netrc`, null)).toMatch(/netrc/);
    expect(credentialFileReason(`${H}/.config/gh/hosts.yml`, null)).toMatch(/gh/);
    expect(credentialFileReason(`${H}/.config/gcloud/application_default_credentials.json`, null)).toMatch(/Google Cloud/);
    expect(credentialFileReason(`${H}/app/.env.production`, null)).toMatch(/\.env/);
    expect(credentialFileReason(`${H}/app/.env.example`, 'A=b')).toBeNull();
    expect(credentialFileReason(`${H}/app/key.pem`, '-----BEGIN RSA PRIVATE KEY-----\nabc')).toBe('contains a private key');
    expect(credentialFileReason(`${H}/app/readme.md`, 'use GITHUB_TOKEN from the environment')).toBeNull();
    expect(storageCredentialKind('tabcomputer-remote-code')).toBe('control');
    expect(storageCredentialKind('tabcomputer_github_token')).toBe('credential');
    expect(storageCredentialKind('wal:/home/user/.claude/.credentials.json')).toBe('credential');
    expect(storageCredentialKind('shiro_github_token')).toBe('credential');      // the pre-rename name
    expect(storageCredentialKind('tabcomputer-panes', '{"layout":1}')).toBeNull();
    // ssh remotes keep their user; only a login goes
    expect(scrubCredentialLines(`${H}/p/.git/config`, '[remote "o"]\n\turl = ssh://git@github.com/a/b.git\n')).toBeNull();
    expect(scrubCredentialLines(`${H}/p/.git/config`, '[remote "o"]\n\turl = https://u:pw12345@example.com/a.git\n')!.text).toContain('url = https://example.com/a.git');
  });
});

describe('what a seed carries', () => {
  it('no credential by default: files, lines inside files, and browser storage', async () => {
    const state = await collectSeedState(fs);
    expectNoSecret(everythingIn(state.ndjson, state.storageJson), 'the seed');
    const paths = pathsIn(state.ndjson);
    // the work is there
    for (const kept of ['project/hello.txt', 'project/src/app.js', 'project/.env.example', '.claude/settings.json', '.ssh/id_ed25519.pub', '.ssh/known_hosts', '.gitconfig', '.npmrc', '.bashrc', '.bash_history', 'project/.git/config']) {
      expect(paths, kept).toContain(`${H}/${kept}`);
    }
    // the sign-ins are not
    for (const gone of ['.claude/.credentials.json', '.claude.json', '.ssh/id_ed25519', '.netrc', '.config/gh/hosts.yml', '.aws/credentials', 'project/.env', 'project/notes.txt']) {
      expect(paths, gone).not.toContain(`${H}/${gone}`);
    }
    // config files keep what is not a login
    const gitconfig = fileIn(state.ndjson, `${H}/.gitconfig`)!;
    expect(gitconfig).toContain('name = Some One');
    expect(gitconfig).toContain('st = status');
    expect(gitconfig).not.toContain('credential');
    expect(gitconfig).toContain('[url "https://github.com/"]');
    const repo = fileIn(state.ndjson, `${H}/project/.git/config`)!;
    expect(repo).toContain('url = https://github.com/someone/project.git');
    expect(repo).toContain('url = ssh://git@github.com/someone/project.git');
    expect(fileIn(state.ndjson, `${H}/.npmrc`)).toBe('registry=https://registry.npmjs.org/\nsave-exact=true\n');
    expect(fileIn(state.ndjson, `${H}/.bashrc`)).toBe("alias ll='ls -l'\nexport EDITOR=vim\n");
    expect(fileIn(state.ndjson, `${H}/.bash_history`)).toBe('ls\ncd project\n');
    // of localStorage, layout and preferences only
    expect(JSON.parse(state.storageJson)).toEqual({ 'tabcomputer-desktop-theme': 'dark', 'tabcomputer-panes': '{"layout":"single"}' });
    expect(state.stats.detectedKeys).toEqual([]);
    expect(state.stats.files).toBe(paths.filter((p) => !['dir'].includes(p)).length - state.stats.dirs);
  });

  it('says exactly what was left out, by name and never by value', async () => {
    const state = await collectSeedState(fs);
    expect(state.left.files.map((f) => f.path).sort()).toEqual([
      '.aws/credentials', '.claude.json', '.claude/.credentials.json', '.config/gh/hosts.yml', '.netrc', '.ssh/id_ed25519', 'project/.env', 'project/notes.txt',
    ].map((p) => `${H}/${p}`).sort());
    expect(Object.fromEntries(state.left.files.map((f) => [f.path.slice(H.length + 1), f.why]))).toMatchObject({
      '.claude/.credentials.json': 'Claude credentials', '.ssh/id_ed25519': 'ssh key or agent state', '.netrc': 'netrc logins',
      '.config/gh/hosts.yml': "gh's sign-in", 'project/.env': 'environment file (.env)', 'project/notes.txt': 'contains a GitHub token',
    });
    expect(state.left.scrubbed.map((f) => f.path).sort()).toEqual(['.bash_history', '.bashrc', '.gitconfig', '.npmrc', 'project/.git/config'].map((p) => `${H}/${p}`).sort());
    const scrubbed = Object.fromEntries(state.left.scrubbed.map((f) => [f.path.slice(H.length + 1), f.removed]));
    expect(scrubbed['.gitconfig']).toEqual(['a [credential] section', 'a login inside a URL']);
    expect(scrubbed['.npmrc']).toEqual(['a registry login']);
    expect(scrubbed['.bashrc']).toEqual(['ANTHROPIC_API_KEY=…', 'MY_SERVICE_SECRET=…']);
    expect(state.left.credentials).toEqual([
      'GitHub token (tabcomputer_github_token)', 'Anthropic API key (tabcomputer_anthropic_key)', 'OpenAI API key (tabcomputer_openai_key)',
      'own relay setting (tabcomputer_relay)', 'remote-control code (tabcomputer-remote-code)',
      `saved copy of ${H}/.claude/.credentials.json (wal:${H}/.claude/.credentials.json)`, 'some_plugin_session_token', 'unlisted-thing',
      'tabcomputer-console-log',   // a script printed a token, and the log kept it
    ].sort());
    // not a credential, but not layout or preferences either: named, and left behind
    expect(state.left.storage).toEqual(['tabcomputer-watchdog']);
    expectNoSecret(JSON.stringify(state.left), 'the report');
  });

  it('--with-credentials keeps them (your own machine), except what would let someone drive the tab', async () => {
    const state = await collectSeedState(fs, { withCredentials: true });
    const all = everythingIn(state.ndjson, state.storageJson);
    expect(all).toContain(S.claudeAccess);
    expect(all).toContain(S.github);
    expect(all).toContain(S.sshKey);
    expect(all).not.toContain(S.remote);
    expect(JSON.parse(state.storageJson)['tabcomputer-remote-code']).toBeUndefined();
    expect(state.stats.detectedKeys.join('\n')).toContain('GitHub token (tabcomputer_github_token)');
    expect(state.stats.detectedKeys.join('\n')).toContain(`${H}/.claude/.credentials.json (Claude credentials)`);
    expectNoSecret(state.stats.detectedKeys.join('\n'), 'the list of what is included');
  });
});

describe('seed share', () => {
  const upload = async () => JSON.parse(await gunzip(uploads[0]));

  it('uploads no credential, and lists what it left out', async () => {
    const { output, exitCode } = await run(shell, 'seed share --yes');
    expect(exitCode).toBe(0);
    expect(uploads).toHaveLength(1);
    const envelope = await upload();
    expectNoSecret(everythingIn(envelope.ndjson, envelope.storage), 'the upload');
    expectNoSecret(await gunzip(uploads[0]), 'the raw upload');
    expect(pathsIn(envelope.ndjson)).toContain(`${H}/project/hello.txt`);
    expect(pathsIn(envelope.ndjson)).not.toContain(`${H}/.claude/.credentials.json`);
    expect(envelope.files).toBe(pathsIn(envelope.ndjson).length - envelope.dirs);
    const text = output.replace(/\r/g, '');
    expect(text).toContain('Left out (a seed carries no credentials):');
    for (const line of [
      `${H}/.claude/.credentials.json  (Claude credentials)`, `${H}/.ssh/id_ed25519  (ssh key or agent state)`, `${H}/.netrc  (netrc logins)`,
      `${H}/.config/gh/hosts.yml  (gh's sign-in)`, `${H}/project/notes.txt  (contains a GitHub token)`,
      `${H}/.gitconfig: kept, without a [credential] section, a login inside a URL`, `${H}/.npmrc: kept, without a registry login`,
      'saved in the browser: GitHub token (tabcomputer_github_token)', 'saved in the browser: remote-control code (tabcomputer-remote-code)',
      `saved in the browser: saved copy of ${H}/.claude/.credentials.json`,
    ]) expect(text, line).toContain(line);
    expectNoSecret(text, 'the output');
    expect(text).toContain('http://shiro.test/s/abcd1234');
  });

  it('shows what will be shared and uploads nothing without a yes', async () => {
    const { output, exitCode } = await run(shell, 'seed share');   // no terminal to ask at (a script, an agent's tool)
    expect(exitCode).toBe(1);
    expect(uploads).toHaveLength(0);
    const text = output.replace(/\r/g, '');
    expect(text).toMatch(/Files:\s+\d+/);
    expect(text).toMatch(/Data size:\s+[\d.]+ MB/);
    expect(text).toMatch(/Compressed:\s+\d+ KB/);
    expect(text).toContain('Anyone with the link can download all of it.');
    expect(text).toContain('nothing was uploaded');
    expect(text).toContain('--yes');
  });

  it('asks at the terminal: anything but yes cancels', async () => {
    const shown: string[] = [];
    const terminal = (answer: string) => ({ writeOutput: (t: string) => { shown.push(t); }, waitForUserInput: async () => answer });
    const exec = (answer: string) => {
      const ctx: any = { args: ['share'], fs, cwd: H, env: {}, stdin: '', stdout: '', stderr: '', shell, terminal: terminal(answer), stdinIsTTY: true, stdoutIsTTY: true };
      return seedCmd.exec(ctx).then((status) => ({ status, ctx }));
    };
    const no = await exec('n');
    expect(no.status).toBe(1);
    expect(uploads).toHaveLength(0);
    expect(no.ctx.stdout).toContain('Cancelled. Nothing was uploaded.');
    // the question came after the whole picture
    expect(shown[0]).toMatch(/Files:\s+\d+/);
    expect(shown[0]).toContain('Left out (a seed carries no credentials):');
    expect(shown[0]).toContain('Anyone with the link can download all of it.');
    expect(shown[0]).toMatch(/Type yes to share, anything else to cancel: $/);
    expect((await exec('')).status).toBe(1);
    expect(uploads).toHaveLength(0);

    const yes = await exec('yes');
    expect(yes.status).toBe(0);
    expect(uploads).toHaveLength(1);
    expect(yes.ctx.stdout).toContain('/s/abcd1234');
  });

  it('refuses --with-credentials: a link anyone can open is not for moving sign-ins', async () => {
    const { output, exitCode } = await run(shell, 'seed share --with-credentials --yes');
    expect(exitCode).toBe(2);
    expect(uploads).toHaveLength(0);
    expect(output).toContain('never carries credentials');
    expect(output).toContain('seed gif --with-credentials');
  });

  it('says so, before anything else, on a server that does not keep shared seeds', async () => {
    serverShares = false;
    const { output, exitCode } = await run(shell, 'seed share --yes');
    expect(exitCode).toBe(1);
    expect(uploads).toHaveLength(0);
    expect(output).toContain('this server does not keep shared seeds');
    expect(output).toContain('Nothing was uploaded');
  });

  it('an unknown option is an error, not a share', async () => {
    expect((await run(shell, 'seed share --force')).exitCode).toBe(2);
    expect(uploads).toHaveLength(0);
  });
});

describe('server.mjs and shared seeds', () => {
  const procs: ChildProcess[] = [];
  const dirs: string[] = [];
  afterAll(() => { for (const p of procs) p.kill(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  async function start(env: Record<string, string>): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'seed-share-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html><html><head><title>t</title></head><body><script type="module">import "./assets/index-abc.js"</script></body></html>');
    env = { STATIC_DIR: join(dir, 'dist'), ...env };
    const proc = spawn(process.execPath, [serverPath], { env: { ...process.env, PORT: '0', SEED_DIR: join(dir, 'seeds'), TABCOMPUTER_SEED_SHARE: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(proc);
    const port = await new Promise<number>((resolve, reject) => {
      proc.once('exit', (c) => reject(new Error(`server exited (${c})`)));
      proc.stdout!.on('data', (d) => { const m = /listening on :(\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
    });
    return `http://127.0.0.1:${port}`;
  }

  it('keeps none unless TABCOMPUTER_SEED_SHARE=1, and says so', async () => {
    const off = await start({});
    expect(await (await realFetch(`${off}/api/seed`)).json()).toMatchObject({ enabled: false });
    const up = await realFetch(`${off}/api/seed`, { method: 'POST', body: new Uint8Array([1, 2, 3]) });
    expect(up.status).toBe(404);
    expect(await up.json()).toEqual({ error: 'Seed sharing is off on this server' });
    expect((await realFetch(`${off}/api/seed/abcd1234`)).status).toBe(404);
    expect(existsSync(join(dirs[dirs.length - 1], 'seeds'))).toBe(false);
    expect(await (await realFetch(`${off}/s/abcd1234`)).text()).not.toContain('<base');   // unchanged where sharing is off
  }, 30_000);

  it('with it on, the routes answer (they sit before the /api/ proxy) and a seed comes back as it went', async () => {
    const on = await start({ TABCOMPUTER_SEED_SHARE: '1' });
    expect(await (await realFetch(`${on}/api/seed`)).json()).toEqual({ enabled: true, maxBytes: 512 * 1024, keepDays: 60 });
    const body = new Uint8Array([31, 139, 8, 0, 1, 2, 3, 4]);
    const up = await realFetch(`${on}/api/seed`, { method: 'POST', body });
    expect(up.status).toBe(200);
    const { id, url } = await up.json() as { id: string; url: string };
    expect(url).toBe(`/s/${id}`);
    expect(id).toMatch(/^[a-z0-9]{16}$/);   // the id is all that guards a seed
    expect(new Uint8Array(await (await realFetch(`${on}/api/seed/${id}`)).arrayBuffer())).toEqual(body);
    expect((await realFetch(`${on}/api/seed/zzzz9999`)).status).toBe(404);
    // the link's page can find the app: its entry is named relative to the page
    const page = await (await realFetch(`${on}/s/${id}`)).text();
    expect(page).toContain('<base href="/">');
    expect(page).toContain('import "./assets/index-abc.js"');
    expect(await (await realFetch(`${on}/`)).text()).not.toContain('<base');
    // over the limit: refused (the server may hang up before the whole body is in)
    const big = await realFetch(`${on}/api/seed`, { method: 'POST', body: new Uint8Array(600 * 1024) }).then((r) => r.status, () => 413);
    expect(big).toBe(413);
  }, 30_000);
});

describe('server.mjs: the upload limit counts the address the proxy appended', () => {
  const procs: ChildProcess[] = [];
  const dirs: string[] = [];
  afterAll(() => { for (const p of procs) p.kill(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  it('a client cannot be many addresses by writing its own X-Forwarded-For', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seed-rate-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html><title>t</title>');
    const proc = spawn(process.execPath, [serverPath], { env: { ...process.env, PORT: '0', STATIC_DIR: join(dir, 'dist'), SEED_DIR: join(dir, 'seeds'), TABCOMPUTER_SEED_SHARE: '1', TABCOMPUTER_SEED_RATE: '2' }, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(proc);
    const port = await new Promise<number>((resolve, reject) => {
      proc.once('exit', (c) => reject(new Error(`server exited (${c})`)));
      proc.stdout!.on('data', (d) => { const m = /listening on :(\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
    });
    // as nginx sends it on: what the client wrote, then the address nginx saw
    const upload = (forwarded: string) => realFetch(`http://127.0.0.1:${port}/api/seed`, { method: 'POST', body: new Uint8Array([31, 139, 8, 0]), headers: { 'x-forwarded-for': forwarded } });
    const first = await upload('198.51.100.1, 203.0.113.7');
    expect(first.status).toBe(200);
    expect((await upload('198.51.100.2, 203.0.113.7')).status).toBe(200);
    // a third from the same real address, under a third made-up one: over the limit of 2
    const third = await upload('198.51.100.3, 203.0.113.7');
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: 'Rate limit exceeded (2/month)' });
    // another real address has its own count, whatever it wrote in front
    expect((await upload('198.51.100.1, 203.0.113.8')).status).toBe(200);
    // and the seed's record holds the real address
    const { id } = await first.json() as { id: string };
    expect(JSON.parse(readFileSync(join(dir, 'seeds', `${id}.meta`), 'utf8')).ip).toBe('203.0.113.7');
  }, 30_000);
});

describe('seed (the clipboard snippet)', () => {
  it('carries no credential, and opens this site, not another', async () => {
    const { output, exitCode } = await run(shell, 'seed');
    expect(exitCode).toBe(0);
    expectNoSecret(clipboard, 'the snippet');
    for (const [name, value] of Object.entries(S)) expect(clipboard.includes(btoa(value)), `the snippet carries ${name} (base64)`).toBe(false);
    expect(clipboard).toContain("iframe.src='http://shiro.test/'");
    expect(clipboard).not.toContain('shiro.computer');
    // the state is posted to that origin only
    expect(clipboard).toContain("context:buildContext()},'http://shiro.test')");
    expect(output).toContain('Left out (a seed carries no credentials):');
    expectNoSecret(output, 'the output');
  });

  it('--with-credentials says so, bluntly', async () => {
    const { output, exitCode } = await run(shell, 'seed --with-credentials');
    expect(exitCode).toBe(0);
    expect(clipboard).toContain(btoa(CLAUDE_CREDS));
    expect(output).toContain('WARNING: this seed carries your credentials.');
    expect(output).toContain('Whoever gets it is signed in as you.');
    expect(output).toContain('Never included: remote-control code (tabcomputer-remote-code)');
    expectNoSecret(output, 'the output');
  });
});

describe('importing a seed', () => {
  /** A seed made elsewhere, with everything in it a seed could carry */
  async function foreignSeed(): Promise<{ ndjson: string; storage: Record<string, string> }> {
    const state = await collectSeedState(fs, { withCredentials: true });
    const storage = JSON.parse(state.storageJson);
    // …and what a hand-made one could add
    storage['tabcomputer-remote-code'] = 'evil-remote-code#aaaaaaaaaaaaaaaaaaaaaaaaaa';
    storage[`wal:${H}/.claude/.credentials.json`] = '{"claudeAiOauth":{"accessToken":"THEIR-CLAUDE"}}';
    return { ndjson: state.ndjson, storage };
  }
  const MINE = {
    claude: JSON.stringify({ claudeAiOauth: { accessToken: 'MY-CLAUDE-ACCESS', refreshToken: 'MY-CLAUDE-REFRESH' } }),
    github: 'gho_MyOwnGitHubToken00000000000000000000000',
    ssh: '-----BEGIN OPENSSH PRIVATE KEY-----\nMY-SSH-KEY\n-----END OPENSSH PRIVATE KEY-----\n',
  };
  async function becomeTheImporter() {
    await fs.importAll([]);
    localStorage.clear();
    await fs.mkdir(`${H}/.claude`, { recursive: true });
    await fs.mkdir(`${H}/.ssh`, { recursive: true });
    await fs.mkdir(`${H}/mine`, { recursive: true });
    await fs.writeFile(`${H}/.claude/.credentials.json`, MINE.claude);
    await fs.writeFile(`${H}/.ssh/id_ed25519`, MINE.ssh);
    await fs.writeFile(`${H}/mine/old.txt`, 'replaced by the seed');
    localStorage.setItem('tabcomputer_github_token', MINE.github);
    localStorage.setItem('tabcomputer-desktop-theme', 'light');
  }

  it('replaces the files, but not the importer\'s sign-ins', async () => {
    const seed = await foreignSeed();
    await becomeTheImporter();
    const result = await importSeedState(fs, await parseSeedNdjson(seed.ndjson), seed.storage);

    // the seed's machine is here
    expect(await fs.readFile(`${H}/project/hello.txt`, 'utf8')).toBe('Hello, tabcomputer!');
    await expect(fs.readFile(`${H}/mine/old.txt`, 'utf8')).rejects.toThrow();
    expect(localStorage.getItem('tabcomputer-desktop-theme')).toBe('dark');
    // the importer is still signed in as themselves
    expect(await fs.readFile(`${H}/.claude/.credentials.json`, 'utf8')).toBe(MINE.claude);
    expect(await fs.readFile(`${H}/.ssh/id_ed25519`, 'utf8')).toBe(MINE.ssh);
    expect(localStorage.getItem('tabcomputer_github_token')).toBe(MINE.github);
    // and nothing that drives or reroutes the tab came along
    expect(localStorage.getItem('tabcomputer-remote-code')).toBeNull();
    expect(localStorage.getItem(`wal:${H}/.claude/.credentials.json`)).toBeNull();
    expect(result.keptFiles.sort()).toEqual([`${H}/.claude/.credentials.json`, `${H}/.ssh/id_ed25519`]);
    expect(result.skippedStorage).toEqual(expect.arrayContaining(['GitHub token (tabcomputer_github_token)', 'remote-control code (tabcomputer-remote-code)']));
  });

  it('a machine with no sign-in of its own takes the seed\'s (moving your own machine), never a remote code', async () => {
    const seed = await foreignSeed();
    await fs.importAll([]);
    localStorage.clear();
    await importSeedState(fs, await parseSeedNdjson(seed.ndjson), JSON.stringify(seed.storage));
    expect(await fs.readFile(`${H}/.claude/.credentials.json`, 'utf8')).toBe(CLAUDE_CREDS);
    expect(localStorage.getItem('tabcomputer_github_token')).toBe(S.github);
    expect(localStorage.getItem('tabcomputer-remote-code')).toBeNull();
    expect(Object.keys(store).filter((k) => k.startsWith('wal:'))).toEqual([]);
  });

  it('every import path goes through it, and a shared link asks first', () => {
    const main = readFileSync(new URL('../../../src/main.ts', import.meta.url), 'utf8');
    expect(main.match(/importSeedState\(fs, /g)?.length).toBe(3);        // the two message formats and /s/:id
    expect(main).not.toMatch(/fs\.importAll\(/);
    expect(main).not.toMatch(/localStorage\.setItem\(key, value as string\)/);
    // (asked in a main profile, in the run links' window: inbound-links.test.ts)
    const share = main.slice(main.indexOf('const inbound = '), main.indexOf('Initialize drag-and-drop seed GIF import'));
    expect(share).toContain('handleInboundLink({');
    expect(share).toContain('importSeedState(fs, ');
    expect(main).not.toMatch(/window\.confirm\(/);
  });
});
