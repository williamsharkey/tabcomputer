/**
 * Sign-out for a shared computer (docs/CLASSROOM.md, tabcomputer#130): one
 * action that removes the profile's sign-ins and every file from this
 * browser, after a confirm that says what goes and which work GitHub does not
 * have yet. `signout` (src/commands/signout.ts) and Settings, Accounts.
 *
 * What a sign-in is comes from src/credentials.ts. The sign-ins are removed
 * at once; the rest (the filesystem's IndexedDB, caches, every other key) is
 * deleted by the next document before it opens anything (`bootSignOut`, the
 * first thing in main()), because the running page still has the database
 * open and still writes its logs.
 */
import type { FileSystem } from './filesystem';
import {
  API_KEY_PROVIDERS, CLAUDE_CREDENTIALS_FILE, CREDENTIAL_HOME_FILES, GITHUB_TOKEN_STORAGE_KEY, HOME_DIRS,
  REMOTE_CODE_STORAGE_KEY, STORED_CREDENTIALS, WAL_STORAGE_PREFIX, storageCredentialKind,
} from './credentials';

/** sessionStorage: this tab's next document deletes the profile */
export const SIGN_OUT_KEY = 'tabcomputer-signout';

type Storage = Pick<globalThis.Storage, 'getItem' | 'removeItem' | 'key' | 'length'>;

export interface SignOutPlan {
  /** Sign-ins present, by name: never a value */
  signins: string[];
  /** Files and folders directly in the home folder */
  homeEntries: number;
  /** Clones of GitHub repositories with work GitHub does not have */
  unpushed: { dir: string; why: string }[];
}

const storageKeys = (s: Storage): string[] => {
  const keys: string[] = [];
  for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k !== null) keys.push(k); }
  return keys;
};

/** Repositories under `home`, a few levels down (not inside dot-folders or node_modules) */
async function findRepos(fs: FileSystem, home: string, max = 60): Promise<string[]> {
  const out: string[] = [];
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= max || visited++ > 3000) return;
    if (await fs.exists(`${dir}/.git`).catch(() => false)) { out.push(dir); return; }
    if (depth >= 4) return;
    let names: string[] = [];
    try { names = await fs.readdir(dir) as string[]; } catch { return; }
    for (const name of names) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const path = `${dir}/${name}`;
      const st = await fs.stat(path).catch(() => null);
      if (st?.type === 'dir') await walk(path, depth + 1);
    }
  };
  await walk(home, 0);
  return out;
}

/** What signing out will delete, read from the profile as it is now */
export async function signOutPlan(fs: FileSystem, storage: Storage = localStorage, home = '/home/user'): Promise<SignOutPlan> {
  const signins: string[] = [];
  const has = (key: string) => { try { return !!storage.getItem(key); } catch { return false; } };
  if (has(GITHUB_TOKEN_STORAGE_KEY)) signins.push('The GitHub sign-in');
  const claudeFile = await fs.exists(`${home}/${CLAUDE_CREDENTIALS_FILE}`).catch(() => false);
  if (claudeFile || storageKeys(storage).some((k) => k.startsWith(WAL_STORAGE_PREFIX) && k.endsWith(CLAUDE_CREDENTIALS_FILE))) signins.push('The Claude sign-in');
  for (const [provider, keys] of API_KEY_PROVIDERS) if (keys.some(has)) signins.push(`The ${provider} API key`);
  if (has(REMOTE_CODE_STORAGE_KEY)) signins.push('The remote-control code');
  const others = new Set<string>();
  for (const f of CREDENTIAL_HOME_FILES) {
    if (f.path === CLAUDE_CREDENTIALS_FILE || f.path.startsWith('.claude')) continue;
    if (await fs.exists(`${home}/${f.path}`).catch(() => false)) others.add(f.name);
  }
  if (await fs.exists(`${home}/.ssh`).catch(() => false)) others.add('ssh keys');
  if (others.size) signins.push(`Other saved logins: ${[...others].join(', ')}`);
  let homeEntries = 0;
  try { homeEntries = (await fs.readdir(home) as string[]).length; } catch { /* no home folder */ }
  const unpushed: SignOutPlan['unpushed'] = [];
  const { labState, unsavedReason } = await import('./lab');
  for (const dir of await findRepos(fs, home)) {
    const s = await labState(fs, dir).catch(() => null);
    if (s?.unsaved) unpushed.push({ dir: dir.startsWith(home + '/') ? '~' + dir.slice(home.length) : dir, why: unsavedReason(s) });
  }
  return { signins, homeEntries, unpushed };
}

export interface SignOutText {
  title: string;
  /** What is deleted, one line each */
  deleted: string[];
  /** Work that will be lost: empty when GitHub has it all */
  warning: string;
  lost: string[];
  /** What this cannot delete */
  kept: string;
  action: string;
}

/** The confirm's words, the same in Settings and in the terminal */
export function signOutText(plan: SignOutPlan): SignOutText {
  return {
    title: 'Sign out of this computer?',
    deleted: [
      ...(plan.signins.length ? plan.signins : ['No sign-in is saved here']),
      `Every file in this tab computer: the home folder (${plan.homeEntries} ${plan.homeEntries === 1 ? 'item' : 'items'}), installed programs and settings`,
    ],
    warning: plan.unpushed.length ? 'GitHub does not have this work yet. Signing out deletes it. Submit or push it first.' : '',
    lost: plan.unpushed.map((u) => `${u.dir}: ${u.why}`),
    kept: 'This deletes them from this browser only. The GitHub sign-in stays valid at GitHub until it is revoked there (github.com, Settings, Applications). Guests opened from this computer are separate and are not deleted.',
    action: 'Sign Out and Erase',
  };
}

/** The same as lines for a terminal */
export function signOutLines(plan: SignOutPlan): string {
  const t = signOutText(plan);
  const lines = [t.title, 'It deletes, from this browser:', ...t.deleted.map((d) => `  - ${d}`)];
  if (t.warning) lines.push('', t.warning, ...t.lost.map((l) => `  - ${l}`));
  lines.push('', t.kept);
  return lines.join('\n') + '\n';
}

/** Remove every sign-in localStorage holds, now. Returns how many entries went. */
export function removeStoredSignIns(storage: Storage = localStorage): number {
  let n = 0;
  for (const key of storageKeys(storage)) {
    let value: string | null = null;
    try { value = storage.getItem(key); } catch { /* unreadable: decided by its name */ }
    if (STORED_CREDENTIALS.some((c) => c.key === key) || storageCredentialKind(key, value) !== null) {
      try { storage.removeItem(key); n++; } catch { /* storage refused */ }
    }
  }
  return n;
}

/** Remove the files that hold a sign-in (src/credentials.ts), now. The other files go with the profile. */
export async function removeCredentialFiles(fs: FileSystem): Promise<void> {
  for (const home of HOME_DIRS) {
    for (const f of CREDENTIAL_HOME_FILES) {
      const path = `${home}/${f.path}`;
      try {
        if (f.dir) await fs.rm(path, { recursive: true });
        else await fs.unlink(path);
      } catch { /* not there */ }
    }
  }
}

/**
 * Do it (the caller has confirmed): the sign-ins go now, then this tab loads
 * a document that deletes everything else and says so. Does not return to a
 * usable page.
 */
export async function signOutOfThisComputer(fs: FileSystem, go: () => void = () => location.replace(location.origin + '/')): Promise<void> {
  removeStoredSignIns();
  await removeCredentialFiles(fs).catch(() => {});
  // Edits to the credential files that node's fs was still holding
  removeStoredSignIns();
  try { sessionStorage.setItem(SIGN_OUT_KEY, '1'); } catch { /* no storage: the sign-ins are gone, the files stay */ }
  // No "leave site?" for work the confirm already named (src/lab.ts, main.ts's beforeunload)
  (globalThis as Record<string, unknown>)['__tabcomputerLeaving'] = true;
  go();
}

/**
 * First thing in main(): a tab that asked to sign out deletes the profile
 * here, before anything opens storage, and shows what happened. True when
 * this load is that document (the boot stops).
 */
export async function bootSignOut(): Promise<boolean> {
  let asked = false;
  try { asked = sessionStorage.getItem(SIGN_OUT_KEY) === '1'; } catch { /* no storage */ }
  if (!asked) return false;
  const { wipeAllStorage } = await import('./guest');
  const left = await wipeAllStorage();
  // Something stayed (another tab has the database open): a reload of this page tries again
  if (left.length) { try { sessionStorage.setItem(SIGN_OUT_KEY, '1'); } catch { /* no storage */ } }
  document.title = 'Signed out';
  const body = document.body;
  body.textContent = '';
  body.style.cssText = 'font: 15px system-ui, sans-serif; margin: 15vh auto; max-width: 34em; padding: 0 20px; color: #888; background: #111';
  const h = document.createElement('h1');
  h.style.cssText = 'font-size: 20px; color: #ddd';
  h.textContent = left.length ? 'This computer was only partly signed out' : 'This computer is signed out';
  const p = document.createElement('p');
  p.id = 'signed-out';
  p.textContent = left.length
    ? `Could not delete: ${left.join('; ')}. Close the other tabs of this site and reload this page, or clear this site's data in the browser.`
    : 'The sign-ins and every file this tab computer kept in this browser are deleted. You can close this tab.';
  const a = document.createElement('a');
  a.href = '/';
  a.style.cssText = 'color: #8ab4f8';
  a.textContent = 'Start a new session';
  body.append(h, p, a);
  return true;
}
