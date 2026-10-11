import { Command, CommandContext } from './index';
import { registry } from '../registry';

/**
 * reload: Hot-reload modules from the virtual filesystem
 *
 * Recompiles TypeScript/JavaScript from VFS and hot-swaps modules
 * in the running system without losing state.
 *
 * Usage:
 *   reload commands/ls       # Reload a specific command
 *   reload --list            # List all registered modules
 *   reload --status          # Show module versions and sources
 *   reload --all             # Reload all modules with VFS sources
 *
 * The reloaded module can implement migrateFrom(old) to preserve state.
 */


/**
 * Build a module from the VFS and load it. Relative imports resolve to the
 * page's live modules through hotswap's builder (src/hotswap/build.ts), so a
 * command that imports '../utils/x' or './index' gets the running page's.
 * The checkout root is the directory above the file's src/ (else its own
 * directory).
 */
async function loadFromVFS(ctx: CommandContext, sourcePath: string): Promise<unknown> {
  const { buildSwap } = await import('../hotswap/build');
  const { evaluateBundle, isCommand } = await import('../hotswap/swap');
  const abs = ctx.fs.resolvePath(sourcePath, ctx.cwd);
  const at = abs.lastIndexOf('/src/');
  const root = at >= 0 ? abs.slice(0, at) || '/' : abs.slice(0, abs.lastIndexOf('/')) || '/';
  const built = await buildSwap({ readFile: async (p) => ctx.fs.readFile(p, 'utf8') as Promise<string> }, { root, files: [abs] });
  for (const w of built.warnings) console.warn(`[reload] ${sourcePath}: ${w}`);
  const ns = Object.values(await evaluateBundle(built.code))[0] as Record<string, unknown>;
  if (ns.default) return ns.default;
  // A command module exports its command object (gitCmd): reload that, not the namespace
  const cmds = Object.entries(ns).filter(([k, v]) => !k.startsWith('__') && isCommand(v));
  return cmds.length === 1 ? cmds[0][1] : ns;
}

export const reloadCmd: Command = {
  name: 'reload',
  description: 'Hot-reload modules from virtual filesystem',

  async exec(ctx: CommandContext): Promise<number> {
    const arg = ctx.args[0];

    // List registered modules
    if (arg === '--list' || arg === '-l') {
      const modules = registry.list();
      if (modules.length === 0) {
        ctx.stdout += 'No modules registered.\n';
      } else {
        ctx.stdout += 'Registered modules:\n';
        for (const name of modules.sort()) {
          ctx.stdout += `  ${name}\n`;
        }
      }
      return 0;
    }

    // Show detailed status
    if (arg === '--status' || arg === '-s') {
      const modules = registry.list();
      if (modules.length === 0) {
        ctx.stdout += 'No modules registered.\n';
      } else {
        ctx.stdout += 'Module registry status:\n\n';
        for (const name of modules.sort()) {
          const meta = registry.getMetadata(name);
          if (meta) {
            const age = Math.floor((Date.now() - meta.lastUpdatedAt) / 1000);
            ctx.stdout += `  ${name}\n`;
            ctx.stdout += `    version: ${meta.version}\n`;
            ctx.stdout += `    updated: ${age}s ago\n`;
            if (meta.source) {
              ctx.stdout += `    source: ${meta.source}\n`;
            }
            ctx.stdout += '\n';
          }
        }
      }
      return 0;
    }

    // Reload all modules with sources
    if (arg === '--all' || arg === '-a') {
      const modules = registry.list();
      let reloaded = 0;
      let failed = 0;

      for (const name of modules) {
        const meta = registry.getMetadata(name);
        if (meta?.source) {
          try {
            ctx.stdout += `Reloading ${name} from ${meta.source}...\n`;
            const newModule = await loadFromVFS(ctx, meta.source);
            const result = registry.replace(name, newModule as any, meta.source);
            if (result.migrated) {
              ctx.stdout += `  ✓ Reloaded with state migration\n`;
            } else if (result.error) {
              ctx.stdout += `  ⚠ Reloaded but migration failed: ${result.error.message}\n`;
            } else {
              ctx.stdout += `  ✓ Reloaded (no migration needed)\n`;
            }
            reloaded++;
          } catch (e: any) {
            ctx.stderr += `  ✗ Failed: ${e.message}\n`;
            failed++;
          }
        }
      }

      ctx.stdout += `\nReloaded ${reloaded} module(s)`;
      if (failed > 0) {
        ctx.stdout += `, ${failed} failed`;
      }
      ctx.stdout += '.\n';
      return failed > 0 ? 1 : 0;
    }

    // Show help
    if (!arg || arg === '--help' || arg === '-h') {
      ctx.stdout += 'Usage: reload <module-name> [source-path]\n';
      ctx.stdout += '       reload --list          List registered modules\n';
      ctx.stdout += '       reload --status        Show module versions and sources\n';
      ctx.stdout += '       reload --all           Reload all modules with sources\n';
      ctx.stdout += '\n';
      ctx.stdout += 'Examples:\n';
      ctx.stdout += '  reload commands/ls                    # Reload from registered source\n';
      ctx.stdout += '  reload commands/ls /src/commands/ls.ts  # Reload from specific path\n';
      ctx.stdout += '\n';
      ctx.stdout += 'Modules can implement migrateFrom(old) to preserve state during reload.\n';
      return 0;
    }

    // Reload specific module
    const moduleName = arg;
    const given = ctx.args[1] || registry.getMetadata(moduleName)?.source;
    const sourcePath = given && ctx.fs.resolvePath(given, ctx.cwd);

    if (!sourcePath) {
      ctx.stderr += `reload: no source path for '${moduleName}'\n`;
      ctx.stderr += `Specify a source path: reload ${moduleName} /path/to/source.ts\n`;
      return 1;
    }

    // Check if source exists
    try {
      await ctx.fs.stat(sourcePath);
    } catch {
      ctx.stderr += `reload: source not found: ${sourcePath}\n`;
      return 1;
    }

    ctx.stdout += `Compiling ${sourcePath}...\n`;

    try {
      const newModule = await loadFromVFS(ctx, sourcePath);

      if (registry.has(moduleName)) {
        const result = registry.replace(moduleName, newModule as any, sourcePath);
        if (result.migrated) {
          ctx.stdout += `✓ Hot-reloaded '${moduleName}' with state migration\n`;
        } else if (result.error) {
          ctx.stdout += `⚠ Hot-reloaded '${moduleName}' but migration failed: ${result.error.message}\n`;
        } else {
          ctx.stdout += `✓ Hot-reloaded '${moduleName}'\n`;
        }
      } else {
        registry.register(moduleName, newModule, sourcePath);
        ctx.stdout += `✓ Registered new module '${moduleName}'\n`;
      }

      return 0;
    } catch (e: any) {
      ctx.stderr += `reload: ${e.message}\n`;
      return 1;
    }
  },
};
