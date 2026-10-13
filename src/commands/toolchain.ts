import type { Command, CommandContext } from './index';

/**
 * Prebuilt toolchains (docs/DEBIAN.md "Toolchain layers"):
 *   toolchain list                 the sets, their size, whether installed
 *   toolchain install ID... [--check] [--apt] [-v]
 *                                  apply prebuilt layers (Debian packages, so apt and
 *                                  dpkg know them); --apt installs with apt instead;
 *                                  -v lists each overlay change. A name that is no
 *                                  set is a Debian package: those names are one
 *                                  package set (src/debian/package-sets.ts)
 *   toolchain check ID...          run each set's smoke test
 * Debian is installed first if it isn't.
 */

export interface ToolchainEntry {
  id: string;
  title: string;
  description: string;
  /** The packages asked for, those of the set it extends first. */
  packages: string[];
  /** The set this one is a superset of (`tex-full` extends `tex`): its layer holds that set's packages too. */
  extends?: string;
  /** An applied set that extends this one, so this one is already in place. */
  partOf?: string;
  /** Compressed bytes streamed as programs are first used (0: no prebuilt layer). */
  size: number;
  /** A prebuilt layer for this machine's Debian is on the server. */
  prebuilt: boolean;
  installed: boolean;
  check?: string;
  /** A known limitation, shown by `toolchain list`. */
  note?: string;
}

/** Every toolchain set, for `toolchain list` and the desktop's Settings. */
export async function listToolchains(fs: CommandContext['fs']): Promise<ToolchainEntry[]> {
  const [{ fetchLayerCatalog, appliedLayers }, { installedRootfs }, spec] = await Promise.all([
    import('../debian/layers'), import('../debian/rootfs'), import('../debian/toolchains.json'),
  ]);
  const [catalog, applied, rootfs] = await Promise.all([fetchLayerCatalog(), appliedLayers(fs), installedRootfs(fs)]);
  const status = await fs.readFile('/var/lib/dpkg/status', 'utf8').catch(() => '') as string;
  const have = new Set<string>();
  for (const s of status.split(/\n\n+/)) {
    const name = s.match(/^Package: (.*)$/m)?.[1];
    if (name && /^Status: .* installed$/m.test(s)) have.add(name);
  }
  const sets = ((spec as any).default?.layers ?? (spec as any).layers) as Record<string, { title: string; description: string; packages: string[]; extends?: string; check?: string; note?: string }>;
  /** A set and the sets it extends, the furthest first. */
  const chain = (id: string): string[] => {
    const ids: string[] = [];
    for (let i: string | undefined = id; i && sets[i] && !ids.includes(i); i = sets[i].extends) ids.unshift(i);
    return ids;
  };
  return Object.entries(sets).map(([id, s]) => {
    const layer = catalog.find((l) => l.name === id && (!rootfs || l.base === rootfs.id));
    const packages = [...new Set(chain(id).flatMap((i) => sets[i].packages))];
    return {
      id, title: s.title, description: s.description, packages, extends: s.extends, check: s.check, note: s.note,
      partOf: Object.keys(sets).find((other) => other !== id && !!applied[other] && chain(other).includes(id)),
      size: layer?.chunkBytes ?? 0,
      prebuilt: !!layer,
      installed: !!applied[id] || (packages.length > 0 && packages.every((p) => have.has(p))),
    };
  });
}

async function runShell(ctx: CommandContext, script: string, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  return ctx.shell.fork().runScriptText(script, ctx.terminal, out, err);
}

export const toolchainCmd: Command = {
  name: 'toolchain',
  description: 'Install prebuilt compilers and runtimes (C, Python, Node, Java, LaTeX, ...) in seconds',
  async exec(ctx) {
    const out = (s: string) => { if (ctx.streamStdout) ctx.streamStdout(s); else ctx.stdout += s; };
    const err = (s: string) => { if (ctx.streamStderr) ctx.streamStderr(s); else ctx.stderr += s; };
    const [sub = 'list', ...rest] = ctx.args;
    const flags = new Set(rest.filter((a) => a.startsWith('-')));
    const ids = rest.filter((a) => !a.startsWith('-'));
    const mb = (b: number) => b ? `${(b / 1e6).toFixed(0)} MB` : '-';

    if (sub === 'list' || sub === 'ls') {
      const list = await listToolchains(ctx.fs);
      out(`${'ID'.padEnd(8)} ${'INSTALLED'.padEnd(9)} ${'SIZE'.padStart(7)}  DESCRIPTION\n`);
      for (const t of list) {
        out(`${t.id.padEnd(8)} ${(t.installed ? 'yes' : 'no').padEnd(9)} ${(t.prebuilt ? mb(t.size) : 'apt').padStart(7)}  ${t.title}: ${t.description}\n`);
        if (t.note) out(`${''.padEnd(28)}note: ${t.note}\n`);
      }
      out(`\ntoolchain install ID installs one; SIZE is fetched only as programs are first used ("apt": no prebuilt layer here, apt installs it).\n`);
      return 0;
    }

    if (sub === 'install' || sub === 'add') {
      if (!ids.length) { err('usage: toolchain install ID|PACKAGE... [--check] [--apt] [-v]   (toolchain list shows the IDs; other names are Debian packages)\n'); return 2; }
      const verbose = flags.has('-v') || flags.has('--verbose');
      const all = await listToolchains(ctx.fs);
      // Names that are no toolchain set are Debian packages: together they are one
      // package set, installed from its layer like a toolchain (docs/DEBIAN.md "Package layers")
      const packages = ids.filter((id) => !all.some((t) => t.id === id));
      const { PACKAGE_NAME } = await import('../debian/package-sets');
      for (const id of packages) if (!PACKAGE_NAME.test(id)) { err(`toolchain: ${id} is not a toolchain (toolchain list) or a Debian package name\n`); return 1; }
      const sets = ids.filter((id) => !packages.includes(id));

      // Hundreds of MB in browser storage: keep it from eviction (tabcomputer#71)
      void import('../storage').then(m => m.requestPersistentStorage('toolchain install', true));
      const rootfs = await import('../debian/rootfs');
      if (!await rootfs.installedRootfs(ctx.fs)) {
        out('Installing Debian first (debian install)...\n');
        const code = await runShell(ctx, verbose ? 'debian install -v' : 'debian install', out, err);
        if (code) return code;
      }
      const layers = await import('../debian/layers');
      const overlay = await import('../debian/overlay');
      let status = 0;
      if (packages.length) {
        const ps = await import('../debian/package-sets');
        const missing = await ps.missingPackages(ctx.fs, packages);
        if (!missing.length) out(`${packages.join(', ')}: already installed.\n`);
        else if (flags.has('--apt')) status = (await aptInstall(ctx, missing, out, err)) ? 1 : 0;
        else {
          const r = await ps.installPackageSet(ctx.fs, missing, {
            progress: (m) => out(m + '\n'), signal: (ctx.shell.abortController ?? ctx.shell.inheritedAbort)?.signal,
            afterApply: async () => { for (const l of overlay.overlayReport(await ps.afterLayer(ctx.fs, (n) => !!ctx.shell.commands.get(n)), verbose)) out(l + '\n'); },
          });
          if (!r.ok) {
            if (r.reason === 'stopped') return 130;
            err(`toolchain: ${ps.fallbackSentence(missing, r)}\n`);
            if (await aptInstall(ctx, missing, out, err)) status = 1;
          }
        }
      }
      for (const id of sets) {
        const t = (await listToolchains(ctx.fs)).find((x) => x.id === id)!;
        const t0 = Date.now();
        if (t.note) out(`note: ${t.note}\n`);
        if (t.partOf && !flags.has('--apt')) {
          // The applied superset's files that no package owns (TeX's ls-R, formats
          // and font maps) name more than this set's would: leave them
          out(`${t.title}: already installed, as part of ${t.partOf}.\n`);
          if (flags.has('--check') && t.check) status ||= await check(ctx, t, out, err);
          continue;
        }
        if (t.prebuilt && !flags.has('--apt')) {
          try {
            const r = await layers.applyLayer(ctx.fs, id, { progress: (m) => out(m + '\n') });
            out(`${t.title}: ${r.installed.length} packages installed in ${((Date.now() - t0) / 1000).toFixed(1)} s (${r.paths} paths; files load on first use).\n`);
          } catch (e: any) {
            err(`toolchain: prebuilt ${id} failed (${e?.message ?? e}); installing with apt instead\n`);
            if (await aptInstall(ctx, t.packages, out, err)) { status = 1; continue; }
          }
        } else {
          if (!flags.has('--apt')) out(`No prebuilt ${id} layer on this server for this Debian base; installing with apt (this takes minutes).\n`);
          // The set it extends may have a layer: apt then installs only the rest
          const parent = t.extends && !flags.has('--apt') ? (await listToolchains(ctx.fs)).find((x) => x.id === t.extends) : undefined;
          if (parent?.prebuilt && !parent.installed) {
            try {
              const r = await layers.applyLayer(ctx.fs, parent.id, { progress: (m) => out(m + '\n') });
              out(`${parent.title}: ${r.installed.length} packages installed from the prebuilt ${parent.id} layer.\n`);
            } catch (e: any) { err(`toolchain: prebuilt ${parent.id} failed (${e?.message ?? e}); apt installs it too\n`); }
          }
          if (await aptInstall(ctx, t.packages, out, err)) { status = 1; continue; }
          out(`${t.title}: installed with apt in ${((Date.now() - t0) / 1000).toFixed(0)} s.\n`);
        }
        await overlay.enableDebianShadows(ctx.fs, (n) => !!ctx.shell.commands.get(n));
        for (const l of overlay.overlayReport(await overlay.applyDefaults(ctx.fs), verbose)) out(l + '\n');
        await overlay.refreshShadows(ctx.fs);
        if (flags.has('--check') && t.check) status ||= await check(ctx, t, out, err);
        // javac is a Java program: its JVM takes half a minute or more to start, so it starts now
        // and stays up (src/commands/java.ts). TABCOMPUTER_JAVAC=jvm: the plain javac only.
        if (id === 'java' && ctx.env.TABCOMPUTER_JAVAC !== 'jvm') {
          const java = await import('./java');
          if (await java.javaInstalled(ctx.fs) && java.ensureJavad(ctx.shell).started) {
            out('Java: the compiler is starting in the background (up to a minute). After that, javac takes seconds.\n');
          }
        }
      }
      await ctx.fs.sync();
      return status;
    }

    if (sub === 'check') {
      const all = await listToolchains(ctx.fs);
      let status = 0;
      for (const id of ids.length ? ids : all.filter((t) => t.installed).map((t) => t.id)) {
        const t = all.find((x) => x.id === id);
        if (!t) { err(`toolchain: no toolchain named ${id}\n`); status = 1; continue; }
        status ||= await check(ctx, t, out, err);
      }
      return status;
    }

    err('usage: toolchain list | install ID... [--check] [--apt] [-v] | check [ID...]\n');
    return 2;
  },
};

async function check(ctx: CommandContext, t: ToolchainEntry, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  if (!t.check) return 0;
  const t0 = Date.now();
  const code = await runShell(ctx, t.check, out, err);
  out(`${t.id}: check ${code ? `failed (exit ${code})` : 'passed'} in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
  return code ? 1 : 0;
}

/** apt-get update when there are no package lists yet, then install. Returns the exit status. */
async function aptInstall(ctx: CommandContext, packages: string[], out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const lists = await ctx.fs.readdir('/var/lib/apt/lists').catch(() => [] as string[]);
  if (!lists.some((f) => f.endsWith('_Packages'))) {
    const code = await runShell(ctx, 'sudo apt-get update', out, err);
    if (code) return code;
  }
  // (TABCOMPUTER_APT_LAYERS=0: the caller has already asked for a layer, or was told to use apt)
  return runShell(ctx, `sudo DEBIAN_FRONTEND=noninteractive TABCOMPUTER_APT_LAYERS=0 apt-get install -y ${packages.join(' ')}`, out, err);
}
