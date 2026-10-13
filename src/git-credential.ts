/**
 * GitHub sign-in for the full git (`pkg install git`): a credential helper in
 * ~/.gitconfig backed by the builtin gh, as real `gh auth setup-git` writes.
 * The builtin git uses the token directly; the full git asks the helper
 * (`gh auth git-credential get`), which answers with the signed-in token.
 * Written by `gh auth setup-git`, after a sign-in, and when git is installed.
 */

interface FsLike {
  readFile(path: string, enc: 'utf8'): Promise<string | Uint8Array>;
  writeFile(path: string, data: string): Promise<void>;
}

export const GITCONFIG = '/home/user/.gitconfig';
const HOSTS = ['https://github.com', 'https://gist.github.com'];

/** The ~/.gitconfig sections real `gh auth setup-git` writes (helper = clears earlier helpers for the host). */
export function helperSections(): string {
  return HOSTS.map((h) => `[credential "${h}"]\n\thelper =\n\thelper = !gh auth git-credential\n`).join('');
}

/** Add the gh credential helper to ~/.gitconfig unless it's there. Returns true when it wrote. */
export async function ensureGitCredentialHelper(fs: FsLike, path = GITCONFIG): Promise<boolean> {
  let text = '';
  try { text = String(await fs.readFile(path, 'utf8')); } catch { /* none yet */ }
  if (text.includes('gh auth git-credential')) return false;
  await fs.writeFile(path, (text && !text.endsWith('\n') ? text + '\n' : text) + helperSections());
  return true;
}

/**
 * git's credential protocol (`gh auth git-credential get|store|erase`): key=value
 * lines in; for `get` on github.com or gist.github.com, the token as the password.
 * null: nothing to say (another host, no host at all, another protocol than https).
 */
export function credentialAnswer(op: string, input: string, token: string | null | undefined): string | null {
  if (op !== 'get' || !token) return null;
  const req: Record<string, string> = {};
  for (const line of input.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) req[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  // The request has to name the host: the token is GitHub's, and a request that names none is for no one
  const host = req.host;
  if (host !== 'github.com' && host !== 'gist.github.com') return null;
  if (req.protocol && req.protocol !== 'https') return null;
  return `protocol=https\nhost=${host}\nusername=x-access-token\npassword=${token}\n`;
}
