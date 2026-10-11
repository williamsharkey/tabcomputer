/** Bun.which(cmd, { PATH, cwd }): the first executable `cmd` on PATH, or null */
export interface WhichFs {
  statSync(path: string): { isFile(): boolean; mode: number };
}

export function which(fs: WhichFs, cmd: string, opts: { PATH?: string; cwd?: string } = {}, env: { PATH?: string; cwd: string } = { cwd: '/' }): string | null {
  if (!cmd) return null;
  const cwd = opts.cwd ?? env.cwd;
  const executable = (p: string) => {
    try {
      const st = fs.statSync(p);
      // (the tab's files often carry no execute bit: a regular file on PATH counts, as the shell runs it)
      return st.isFile();
    } catch { return false; }
  };
  const abs = (p: string) => (p.startsWith('/') ? p : `${cwd.replace(/\/$/, '')}/${p}`).replace(/\/\.\//g, '/');
  // a path (with a slash) is looked at as it is
  if (cmd.includes('/')) return executable(abs(cmd)) ? abs(cmd) : null;
  for (const d of (opts.PATH ?? env.PATH ?? '').split(':')) {
    if (!d) continue;
    const p = `${abs(d).replace(/\/$/, '')}/${cmd}`;
    if (executable(p)) return p;
  }
  return null;
}
