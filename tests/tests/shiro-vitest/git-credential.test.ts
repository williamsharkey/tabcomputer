import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestShell } from './helpers';
import { credentialAnswer, ensureGitCredentialHelper, helperSections } from '@shiro/git-credential';
import { ensureGitIdentity } from '@shiro/github-auth';
import { ghCmd } from '@shiro/commands/gh';

// tabcomputer#39: with the full git (pkg install git) on PATH, `git push` after a
// GitHub sign-in asked for a username: no credential helper, `gh auth setup-git`
// wrote nothing and `gh auth git-credential` didn't exist.
const TOKEN = 'gho_testToken123';

// A profile that signed in before the helper existed gets it at boot (main.ts), so the
// full git can push: the boot line must stay next to where the stored token is read.
describe('the helper for a profile signed in before it existed', () => {
  it('boot writes it when a GitHub token is stored', async () => {
    const { readFileSync } = await import('node:fs');
    const main = readFileSync(new URL('../../../src/main.ts', import.meta.url), 'utf8');
    const at = main.indexOf("shell.env['GITHUB_TOKEN'] = storedGithubToken;");
    expect(at).toBeGreaterThan(-1);
    expect(main.slice(at, at + 600)).toMatch(/if \(storedGithubToken\) void import\('\.\/git-credential'\)\.then\(\(m\) => m\.ensureGitCredentialHelper\(fs\)\)/);
  });
});

describe('gh as git credential helper', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const fresh = async () => {
    const t = await createTestShell();
    await t.fs.unlink('/home/user/.gitconfig').catch(() => {}); // (the test filesystem is shared)
    return t;
  };

  it('answers git-credential get for github.com, nothing else', () => {
    expect(credentialAnswer('get', 'protocol=https\nhost=github.com\n', TOKEN))
      .toBe(`protocol=https\nhost=github.com\nusername=x-access-token\npassword=${TOKEN}\n`);
    expect(credentialAnswer('get', 'protocol=https\nhost=gitlab.com\n', TOKEN)).toBeNull();
    expect(credentialAnswer('get', 'protocol=http\nhost=github.com\n', TOKEN)).toBeNull();
    expect(credentialAnswer('get', 'host=github.com\n', null)).toBeNull();
    expect(credentialAnswer('store', 'host=github.com\n', TOKEN)).toBeNull();
    expect(credentialAnswer('get', 'protocol=https\nhost=gist.github.com\n', TOKEN))
      .toBe(`protocol=https\nhost=gist.github.com\nusername=x-access-token\npassword=${TOKEN}\n`);
    // a request that names no host is not GitHub's: no token
    expect(credentialAnswer('get', 'protocol=https\n', TOKEN)).toBeNull();
    expect(credentialAnswer('get', '', TOKEN)).toBeNull();
    expect(credentialAnswer('get', 'protocol=https\nhost=\n', TOKEN)).toBeNull();
    expect(credentialAnswer('get', 'protocol=https\npath=github.com/a/b\n', TOKEN)).toBeNull();
    // nor one that names GitHub and then another host, or a host that only looks like it
    expect(credentialAnswer('get', 'protocol=https\nhost=github.com\nhost=git.example.com\n', TOKEN)).toBeNull();
    expect(credentialAnswer('get', 'protocol=https\nhost=github.com.example.com\n', TOKEN)).toBeNull();
    expect(credentialAnswer('get', 'protocol=https\nhost=github.com:8443\n', TOKEN)).toBeNull();
  });

  it('setup writes the helper once and keeps what ~/.gitconfig had', async () => {
    const { fs } = await fresh();
    await fs.writeFile('/home/user/.gitconfig', '[user]\n\tname = Ada');
    expect(await ensureGitCredentialHelper(fs as any)).toBe(true);
    expect(await ensureGitCredentialHelper(fs as any)).toBe(false);
    expect(await fs.readFile('/home/user/.gitconfig', 'utf8')).toBe(`[user]\n\tname = Ada\n${helperSections()}`);
    expect(helperSections()).toContain('[credential "https://github.com"]\n\thelper =\n\thelper = !gh auth git-credential\n');
  });

  it('gh auth setup-git and gh auth git-credential, through the shell', async () => {
    const { fs, shell } = await fresh();
    shell.commands.register(ghCmd);
    shell.env.GITHUB_TOKEN = TOKEN;
    const run = async (cmd: string) => { let out = ''; const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; }); return { code, out: out.replace(/\r\n/g, '\n') }; };
    expect((await run('gh auth setup-git')).code).toBe(0);
    expect(await fs.readFile('/home/user/.gitconfig', 'utf8')).toContain('helper = !gh auth git-credential');
    const r = await run(`printf 'protocol=https\\nhost=github.com\\n\\n' | gh auth git-credential get`);
    expect(r).toEqual({ code: 0, out: `protocol=https\nhost=github.com\nusername=x-access-token\npassword=${TOKEN}\n` });
    expect((await run('gh auth git-credential store </dev/null')).out).toBe('');
  });

  it('a sign-in sets the identity and then the helper (the identity rewrite would flatten it)', async () => {
    const { fs } = await fresh();
    const fetchImpl = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/user')
      ? { login: 'ada', name: 'Ada', id: 1 }
      : [{ email: 'ada@example.com', primary: true, verified: true }]), { status: 200 }));
    expect(await ensureGitIdentity(fs, TOKEN, fetchImpl as any)).toEqual({ name: 'Ada', email: 'ada@example.com' });
    const text = await fs.readFile('/home/user/.gitconfig', 'utf8') as string;
    expect(text).toMatch(/name = Ada[\s\S]*email = ada@example\.com[\s\S]*\[credential "https:\/\/github\.com"\]\n\thelper =\n\thelper = !gh auth git-credential\n/);
    // signed in again with the identity already there: still exactly one helper
    await ensureGitIdentity(fs, TOKEN, fetchImpl as any);
    expect(((await fs.readFile('/home/user/.gitconfig', 'utf8')) as string).match(/!gh auth git-credential/g)).toHaveLength(2);
  });
});
