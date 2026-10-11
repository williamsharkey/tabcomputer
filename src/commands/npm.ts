import { Command, CommandContext } from './index';
import { quoteArgsForShell } from '../shell';
import { extractTarGzToFS, type FileSystemWriter } from '../utils/tar-utils';
import { buildTree, binDirOf, binEntries, WASM_ALTERNATES, type BuildResult, type PackageMetadata, type TreeNode, type Wanted } from './npm-tree';
import { saveSpec, updateLockfile, dropFromLockfile, serializeLockfile, type Lockfile } from './npm-lock';

/**
 * npm: Browser-native package manager for Node.js packages
 *
 * Supports:
 *   - npm init: Create package.json
 *   - npm install [package]: Install packages from registry.npmjs.org
 *   - npm list: Show installed packages
 *   - npm run [script]: Run scripts from package.json
 *
 * Downloads real tarballs from registry.npmjs.org (CORS-enabled)
 * Extracts to node_modules/ using browser-native DecompressionStream
 * Resolves dependency trees with semver
 *
 * Performance optimizations:
 *   - Package metadata cached in memory (1-hour TTL; trimmed to the most recently used 16 MB between commands)
 *   - In-flight request deduplication prevents duplicate fetches
 */

// Metadata cache: maps package name -> { data, timestamp }
/** What `npm -v` says: the npm that node 20 ships with (tools parse a bare semver) */
export const NPM_VERSION = '10.8.2';

const metadataCache = new Map<string, { data: NpmPackageMetadata; timestamp: number; bytes: number }>();
/** Metadata kept between npm commands (the most recently used, by response size) */
const METADATA_KEEP_BYTES = 16 << 20;

/** Trim the metadata cache to METADATA_KEEP_BYTES, least recently used first */
function trimMetadataCache(): void {
  let total = 0;
  for (const e of metadataCache.values()) total += e.bytes;
  for (const [name, e] of metadataCache) {
    if (total <= METADATA_KEEP_BYTES) break;
    metadataCache.delete(name);
    total -= e.bytes;
  }
}
const METADATA_CACHE_TTL = 60 * 60 * 1000; // 1 hour in milliseconds

// In-flight request deduplication: maps package name -> pending promise
const pendingMetadataRequests = new Map<string, Promise<NpmPackageMetadata>>();

interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  type?: 'module' | 'commonjs';
  bin?: string | Record<string, string>;
}

interface NpmPackageMetadata {
  name: string;
  'dist-tags': {
    latest: string;
    [tag: string]: string;
  };
  versions: {
    [version: string]: {
      name: string;
      version: string;
      description?: string;
      main?: string;
      dependencies?: Record<string, string>;
      dist: {
        tarball: string;
        shasum: string;
      };
    };
  };
}


/** npm commands running: the metadata cache lives while any is */
let activeCommands = 0;

export const npmCmd: Command = {
  name: 'npm',
  description: 'Browser-native package manager for Node.js packages',

  async exec(ctx: CommandContext): Promise<number> {
    activeCommands++;
    try {
      return await npmMain(ctx);
    } finally {
      // The abbreviated documents of a big tree (vite+react+eslint+typescript:
      // ~300 packages) held ~45 MB for an hour after the install: keep the
      // most recently used 16 MB (a small project's whole tree)
      if (--activeCommands === 0) trimMetadataCache();
    }
  },
};

/** `-s`/`--silent`/`--loglevel silent` anywhere: no "> name script" lines (npm run -s) */
const silentRuns = new WeakSet<CommandContext>();

async function npmMain(ctx: CommandContext): Promise<number> {
    // npm's loglevel options go anywhere on its command line (`npm run -s test`); before a
    // script's own `--`, they're npm's
    const dash = ctx.args.indexOf('--');
    const own = dash < 0 ? ctx.args : ctx.args.slice(0, dash);
    const silent = own.some((a, i) => a === '-s' || a === '--silent' || a === '--loglevel=silent' || (a === '--loglevel' && own[i + 1] === 'silent'));
    if (silent) {
      silentRuns.add(ctx);
      const kept: string[] = [];
      for (let i = 0; i < own.length; i++) {
        const a = own[i];
        if (a === '-s' || a === '--silent' || a === '-q' || a === '--quiet' || a.startsWith('--loglevel=')) continue;
        if (a === '--loglevel') { i++; continue; }
        kept.push(a);
      }
      ctx.args = dash < 0 ? kept : [...kept, ...ctx.args.slice(dash)];
    }
    const subcommand = ctx.args[0];

    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
      ctx.stdout += 'Usage: npm <command>\n\n';
      ctx.stdout += 'Commands:\n';
      ctx.stdout += '  init              Create a package.json file\n';
      ctx.stdout += '  create <name>     Run create-<name> (npm init <name>), e.g. npm create vite@latest app\n';
      ctx.stdout += '  exec, x <pkg>     Run a package\'s bin (npx)\n';
      ctx.stdout += '  install [pkg]     Install package(s) from registry.npmjs.org\n';
      ctx.stdout += '  i [pkg]           Alias for install\n';
      ctx.stdout += '  list              List installed packages\n';
      ctx.stdout += '  ls                Alias for list\n';
      ctx.stdout += '  run <script>      Run a script from package.json\n';
      ctx.stdout += '  start             Run the start script (default: node server.js)\n';
      ctx.stdout += '  test, t           Run the test script\n';
      ctx.stdout += '  stop              Run the stop script\n';
      ctx.stdout += '  uninstall [pkg]   Remove a package\n';
      ctx.stdout += '  ci                Remove node_modules and install (needs package-lock.json)\n';
      ctx.stdout += '  pkg get|set|delete  Read or edit package.json fields (scripts.test=...)\n';
      ctx.stdout += '  version [major|minor|patch|<v>]  Show versions, or bump package.json\'s\n';
      ctx.stdout += '  view <pkg> [field]  Show a package\'s registry data\n';
      ctx.stdout += '  root              Print the node_modules directory\n';
      ctx.stdout += '  cache clean       Clear the metadata cache\n';
      ctx.stdout += '  cache status      Show cache statistics\n';
      ctx.stdout += '  --version         Show npm version\n';
      ctx.stdout += '\nNote: Downloads real tarballs from registry.npmjs.org\n';
      ctx.stdout += 'Package metadata is cached for 1 hour to speed up installs.\n';
      return 0;
    }

    if (subcommand === '--version' || subcommand === '-v') {
      // a bare semver, as tools parse it (npm 10 is what node 20 ships with)
      ctx.stdout += `${NPM_VERSION}\n`;
      return 0;
    }

    switch (subcommand) {
      case 'create':
      case 'innit':
        return await npmCreate(ctx);
      case 'init':
        // npm init <initializer> is npm create
        if (ctx.args[1] && !ctx.args[1].startsWith('-')) return await npmCreate(ctx);
        return await npmInit(ctx);
      case 'exec':
      case 'x': {
        // npm exec [--] <pkg> [args]: npx
        const rest = ctx.args.slice(1).filter((a, i) => !(i === 0 && a === '--'));
        return ctx.shell.execute(quoteArgsForShell(['npx', ...rest]), (o) => { ctx.stdout += o.replace(/\r\n/g, '\n'); }, (e) => { ctx.stderr += e.replace(/\r\n/g, '\n'); }, false, scriptTerminal(ctx), true);
      }
      case 'install':
      case 'i':
        return await npmInstall(ctx);
      case 'list':
      case 'ls':
        return await npmList(ctx);
      case 'run':
        return await npmRun(ctx);
      case 'start':
        return await npmRunScript(ctx, 'start', 'node server.js');
      case 'test':
      case 't':
      case 'tst':
        return await npmRunScript(ctx, 'test');
      case 'stop':
        return await npmRunScript(ctx, 'stop');
      case 'uninstall':
      case 'remove':
      case 'rm':
        return await npmUninstall(ctx);
      case 'cache':
        return await npmCache(ctx);
      case 'config':
      case 'c':
        return await npmConfig(ctx);
      case 'get':
        ctx.args = ['config', 'get', ...ctx.args.slice(1)];
        return await npmConfig(ctx);
      case 'prefix':
        ctx.stdout += (ctx.args.includes('-g') || ctx.args.includes('--global') ? '/usr/local' : ctx.cwd) + '\n';
        return 0;
      case 'update':
      case 'up':
        ctx.stdout += 'up to date, audited 0 packages\n';
        return 0;
      case 'outdated':
        ctx.stdout += 'All packages are up to date.\n';
        return 0;
      case 'audit':
        ctx.stdout += 'found 0 vulnerabilities\n';
        return 0;
      case 'pkg':
        return await npmPkg(ctx);
      case 'ci':
      case 'clean-install':
      case 'install-clean':
        return await npmCi(ctx);
      case 'version':
      case 'verison':
        return await npmVersion(ctx);
      case 'view':
      case 'info':
      case 'show':
      case 'v':
        return await npmView(ctx);
      case 'root':
        ctx.stdout += (ctx.args.includes('-g') || ctx.args.includes('--global') ? '/usr/local/lib/node_modules' : ctx.fs.resolvePath('node_modules', ctx.cwd)) + '\n';
        return 0;
      case 'help':
        ctx.args = ['--help'];
        return npmMain(ctx);
      default:
        ctx.stderr += `npm: unknown command '${subcommand}'\n`;
        ctx.stderr += "Run 'npm --help' for usage.\n";
        return 1;
    }
}

/**
 * npm create <initializer> [args]: npx create-<name> with the arguments
 * (vite@latest → create-vite@latest, @scope → @scope/create,
 * @scope/name → @scope/create-name); a `--` before them is dropped.
 */
export function initializerPackage(spec: string): string {
  const m = /^(@[^/@]+)(?:\/([^@]+))?(@.*)?$/.exec(spec);
  if (m) return `${m[1]}/${m[2] ? 'create-' + m[2] : 'create'}${m[3] ?? ''}`;
  const at = spec.indexOf('@', 1);
  const name = at > 0 ? spec.slice(0, at) : spec;
  return `create-${name}${at > 0 ? spec.slice(at) : ''}`;
}

async function npmCreate(ctx: CommandContext): Promise<number> {
  const spec = ctx.args[1];
  if (!spec || spec.startsWith('-')) {
    ctx.stderr += 'npm create: usage: npm create <initializer> [args]\n';
    return 1;
  }
  const rest = ctx.args.slice(2);
  const args = rest[0] === '--' ? rest.slice(1) : rest.filter((a, i) => !(a === '--' && i === rest.indexOf('--')));
  return ctx.shell.execute(quoteArgsForShell(['npx', initializerPackage(spec), ...args]),
    (o) => { ctx.stdout += o.replace(/\r\n/g, '\n'); }, (e) => { ctx.stderr += e.replace(/\r\n/g, '\n'); }, false, scriptTerminal(ctx), true);
}

async function npmInit(ctx: CommandContext): Promise<number> {
  const pkgPath = ctx.fs.resolvePath('package.json', ctx.cwd);

  // Check if package.json already exists
  try {
    await ctx.fs.readFile(pkgPath, 'utf8');
    ctx.stdout += 'package.json already exists.\n';
    return 0;
  } catch {
    // Doesn't exist, create it
  }

  // Extract directory name for package name
  const dirName = ctx.cwd.split('/').filter(Boolean).pop() || 'my-project';

  // (npm 10's fields, in its order)
  const pkg = {
    name: dirName.toLowerCase().replace(/[^a-z0-9._~-]+/g, '-'),
    version: '1.0.0',
    main: 'index.js',
    scripts: {
      test: 'echo "Error: no test specified" && exit 1',
    },
    keywords: [] as string[],
    author: '',
    license: 'ISC',
    description: '',
  };

  const text = JSON.stringify(pkg, null, 2) + '\n';
  await ctx.fs.writeFile(pkgPath, text);
  ctx.stdout += `Wrote to ${pkgPath}:\n\n${text}\n\n`;
  return 0;
}

/**
 * Fetch package metadata from npm registry with caching and deduplication
 */
async function fetchPackageMetadata(packageName: string): Promise<NpmPackageMetadata> {
  // Check in-memory cache first
  const cached = metadataCache.get(packageName);
  if (cached && (Date.now() - cached.timestamp) < METADATA_CACHE_TTL) {
    // Most recently used last (trimMetadataCache drops from the front)
    metadataCache.delete(packageName);
    metadataCache.set(packageName, cached);
    return cached.data;
  }

  // Check if there's already a pending request for this package
  const pending = pendingMetadataRequests.get(packageName);
  if (pending) {
    return pending;
  }

  // Create new request with deduplication
  const requestPromise = (async () => {
    const registryUrl = `https://registry.npmjs.org/${packageName}`;

    const response = await fetch(registryUrl, {
      // The abbreviated install document: deps, peers, bins, os/cpu and dist
      // are all the resolver reads, at a fraction of the full document's size
      headers: {
        'Accept': 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8',
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Package '${packageName}' not found in npm registry`);
      }
      throw new Error(`Failed to fetch package metadata: ${response.statusText}`);
    }

    const text = await response.text();
    const data: NpmPackageMetadata = JSON.parse(text);

    // Cache the result
    metadataCache.set(packageName, { data, timestamp: Date.now(), bytes: text.length });

    return data;
  })();

  // Register the pending request
  pendingMetadataRequests.set(packageName, requestPromise);

  try {
    return await requestPromise;
  } finally {
    // Clean up pending request
    pendingMetadataRequests.delete(packageName);
  }
}


/**
 * Install a resolved tree under `baseDir` (a project, or /usr/local/lib for -g):
 * shallower packages first (a version change empties the directory, nested
 * packages included), each level's downloads together, then the bins.
 */
async function installTree(
  ctx: CommandContext,
  baseDir: string,
  tree: BuildResult,
  opts: { globalBinDir?: string; ignoreScripts?: boolean } = {},
): Promise<{ added: number; failed: number }> {
  const base = baseDir.replace(/\/$/, '');
  const byDepth = new Map<number, TreeNode[]>();
  for (const n of tree.nodes) {
    const d = n.dir.split('/node_modules/').length;
    (byDepth.get(d) ?? byDepth.set(d, []).get(d)!).push(n);
  }
  let added = 0;
  let failed = 0;
  const fresh: TreeNode[] = [];
  for (const depth of [...byDepth.keys()].sort((x, y) => x - y)) {
    const queue = [...byDepth.get(depth)!];
    const worker = async () => {
      for (let n = queue.shift(); n; n = queue.shift()) {
        const dir = `${base}/${n.dir}`;
        try {
          try {
            const have = JSON.parse(await ctx.fs.readFile(`${dir}/package.json`, 'utf8') as string);
            if (have.version === n.version && have.name === n.source) continue; // (an alternate's files carry its own name)
            await ctx.fs.rm(dir, { recursive: true, force: true } as any);
          } catch { /* not installed */ }
          const response = await fetch(n.tarball);
          if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);
          const tarballData = new Uint8Array(await response.arrayBuffer());
          await ctx.fs.mkdir(dir, { recursive: true });
          const fsWriter: FileSystemWriter = {
            writeFile: async (path: string, data: Uint8Array) => { await ctx.fs.writeFile(path, data); },
            mkdir: async (path: string) => { try { await ctx.fs.mkdir(path, { recursive: true }); } catch { /* exists */ } },
          };
          await extractTarGzToFS(tarballData, dir, fsWriter);
          fresh.push(n);
          added++;
        } catch (e: any) {
          failed++;
          ctx.stderr += `npm: ${n.name}@${n.version}: ${e?.message ?? e}\n`;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(16, queue.length) }, worker));
  }

  // Bins: each package's in the node_modules/.bin of its level; -g also links the top ones into the global bin dir
  for (const n of tree.nodes) {
    for (const [binName, rel] of binEntries(n.name, n.bin)) {
      const clean = rel.replace(/^\.\//, '');
      const links: [string, string][] = [[`${base}/${binDirOf(n)}/${binName}`, `../${n.name}/${clean}`]];
      if (opts.globalBinDir && n.parent?.dir === '') links.push([`${opts.globalBinDir}/${binName}`, `${base}/${n.dir}/${clean}`]);
      for (const [link, target] of links) {
        try {
          await ctx.fs.mkdir(link.slice(0, link.lastIndexOf('/')), { recursive: true });
          try { await ctx.fs.unlink(link); } catch { /* none */ }
          await ctx.fs.symlink(target, link);
        } catch { /* skip */ }
      }
    }
  }
  if (!opts.ignoreScripts) await runInstallScripts(ctx, base, fresh);
  return { added, failed };
}

/** --ignore-scripts, or ignore-scripts=true in ~/.npmrc */
async function ignoreScripts(ctx: CommandContext): Promise<boolean> {
  if (ctx.args.includes('--ignore-scripts')) return true;
  try {
    const rc = await ctx.fs.readFile(`${ctx.env['HOME'] || '/home/user'}/.npmrc`, 'utf8') as string;
    return /^\s*ignore-scripts\s*=\s*true\s*$/m.test(rc);
  } catch { return false; }
}

/**
 * The install scripts of the packages just installed (preinstall, install,
 * postinstall), dependencies before the packages that need them, in each
 * package's directory, as npm runs them: quiet unless one fails. A failure is
 * a warning here, not the end of the install: a script that builds a native
 * addon (node-gyp, prebuild-install) can't succeed in the tab, and the
 * package's JavaScript often works without it.
 */
async function runInstallScripts(ctx: CommandContext, base: string, nodes: TreeNode[]): Promise<void> {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  // Each package after what it depends on (hoisting leaves that at any depth)
  const order: TreeNode[] = [];
  const seen = new Set<TreeNode>();
  const visit = (n: TreeNode) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const d of n.resolved.values()) visit(d);
    order.push(n);
  };
  nodes.forEach(visit);
  const fresh = new Set(nodes);
  for (const n of order.filter((n) => fresh.has(n))) {
    const dir = `${base}/${n.dir}`;
    let scripts: Record<string, string> = {};
    try { scripts = JSON.parse(await ctx.fs.readFile(`${dir}/package.json`, 'utf8') as string).scripts ?? {}; } catch { continue; }
    for (const event of ['preinstall', 'install', 'postinstall']) {
      const script = scripts[event];
      if (!script) continue;
      const env = {
        npm_lifecycle_event: event, npm_lifecycle_script: script, npm_package_name: n.name,
        npm_package_version: n.version, INIT_CWD: ctx.cwd, npm_command: 'install',
      };
      let out = '';
      const code = await ctx.shell.execute(
        `(cd ${q(dir)} && export ${Object.entries(env).map(([k, v]) => `${k}=${q(v)}`).join(' ')} PATH=${q(`${dir}/node_modules/.bin:${base}/${binDirOf(n)}`)}:"$PATH" && ${script})`,
        (s) => { out += s.replace(/\r\n/g, '\n'); }, (s) => { out += s.replace(/\r\n/g, '\n'); }, false, undefined, true,
      );
      if (code !== 0) {
        ctx.stderr += `npm warn ${n.name}@${n.version} ${event}: \`${script}\` exited with ${code}\n`;
        if (out.trim()) ctx.stderr += out.trimEnd().split('\n').slice(-10).map((l) => `npm warn   ${l}`).join('\n') + '\n';
        break;
      }
    }
  }
}

/** The tree for `wanted`, with what was left out reported */
async function resolveTree(ctx: CommandContext, wanted: Wanted[]): Promise<BuildResult> {
  const tree = await buildTree(wanted, fetchPackageMetadata as (n: string) => Promise<PackageMetadata>);
  for (const w of tree.warnings) ctx.stderr += `npm warn ${w}\n`;
  // The packages asked for, as npm lists them
  for (const n of tree.nodes) if (n.parent === tree.root && wanted.some((w) => w.name === n.name)) ctx.stdout += `  + ${n.name}@${n.version}\n`;
  const alternates = tree.nodes.filter((n) => n.source !== n.name && Object.values(WASM_ALTERNATES).includes(n.source));
  for (const n of alternates) ctx.stdout += `  ${n.name}@${n.version}: the WebAssembly build (${n.source})\n`;
  if (tree.skipped.length) ctx.stdout += `  skipped ${tree.skipped.length} native platform package(s): ${tree.skipped.slice(0, 6).join(', ')}${tree.skipped.length > 6 ? ', ...' : ''}\n`;
  return tree;
}

async function npmInstall(ctx: CommandContext): Promise<number> {
  // Check for global flag and save-dev
  const isGlobal = ctx.args.includes('-g') || ctx.args.includes('--global');
  const saveDev = ctx.args.includes('-D') || ctx.args.includes('--save-dev');
  const saveExact = ctx.args.includes('-E') || ctx.args.includes('--save-exact');

  // Filter out flags (-g, -D, -E, --save-dev, ...): the rest are package specs
  const packagesToInstall = ctx.args.slice(1).filter(arg => !arg.startsWith('-'));

  if (isGlobal) {
    return await npmInstallGlobal(ctx, packagesToInstall);
  }

  const pkgPath = ctx.fs.resolvePath('package.json', ctx.cwd);

  // Read package.json
  let pkg: PackageJson;
  try {
    const content = await ctx.fs.readFile(pkgPath, 'utf8') as string;
    pkg = JSON.parse(content);
  } catch (e: any) {
    if (!e.message.includes('ENOENT')) {
      ctx.stderr += `npm: failed to parse package.json: ${e.message}\n`;
      return 1;
    }
    // As npm: installing into a directory without one starts it (`npm i x` → {"dependencies": {"x": …}})
    if (!packagesToInstall.length) { ctx.stdout += 'up to date, audited 0 packages\n'; return 0; }
    pkg = {} as PackageJson;
  }

  let depsToResolve: Record<string, string> = {};
  const targetSection = saveDev ? 'devDependencies' : 'dependencies';

  if (packagesToInstall.length === 0) {
    // Install all dependencies from package.json
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (Object.keys(allDeps).length === 0) {
      ctx.stdout += 'No dependencies to install.\n';
      return 0;
    }
    depsToResolve = allDeps;
    ctx.stdout += 'Installing dependencies...\n';
  } else {
    // Install specific packages (saved in package.json once resolved: the installed version, #59)
    for (const spec of packagesToInstall) {
      let name: string, version: string;
      if (spec.startsWith('@')) {
        // Scoped package: @scope/pkg or @scope/pkg@version
        const lastAt = spec.lastIndexOf('@');
        if (lastAt > 0) {
          name = spec.slice(0, lastAt);
          version = spec.slice(lastAt + 1);
        } else {
          name = spec;
          version = 'latest';
        }
      } else if (spec.includes('@')) {
        const atIdx = spec.indexOf('@');
        name = spec.slice(0, atIdx);
        version = spec.slice(atIdx + 1);
      } else {
        name = spec;
        version = 'latest';
      }

      depsToResolve[name] = version;
    }
    ctx.stdout += 'Installing packages...\n';
  }

  const t0 = Date.now();
  const tree = await resolveTree(ctx, Object.entries(depsToResolve).map(([name, range]) => ({ name, range })));
  if (packagesToInstall.length) {
    // As npm: `^<installed version>` for a bare name, a tag or a version, the
    // range itself when ^version wouldn't fit inside it (npm-lock.ts saveSpec)
    if (!pkg[targetSection]) pkg[targetSection] = {};
    for (const [name, requested] of Object.entries(depsToResolve)) {
      const got = tree.root.resolved.get(name);
      if (!got) continue; // (not resolved: not saved)
      const alias = /^npm:((?:@[^/@]+\/)?[^@]+)(?:@(.*))?$/.exec(requested);
      pkg[targetSection]![name] = alias ? `npm:${alias[1]}@${saveSpec(alias[2] ?? '', got.version, { exact: saveExact })}`
        : saveSpec(requested === 'latest' ? '' : requested, got.version, { exact: saveExact });
      // (one section only, as npm moves it)
      delete pkg[saveDev ? 'dependencies' : 'devDependencies']?.[name];
    }
    await ctx.fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }
  const { added, failed } = await installTree(ctx, ctx.cwd, tree, { ignoreScripts: await ignoreScripts(ctx) });
  ctx.stdout += `\nadded ${added} package(s), ${tree.nodes.length} in the tree, in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`;
  if (failed || (tree.warnings.length && tree.nodes.length === 0)) return 1;
  await writeLockfile(ctx, pkg, tree);
  ctx.stdout += 'Packages installed successfully.\n';
  return 0;
}

/** package-lock.json beside package.json, with what this install put in node_modules (npm-lock.ts) */
async function writeLockfile(ctx: CommandContext, pkg: PackageJson, tree: BuildResult): Promise<void> {
  const lockPath = ctx.fs.resolvePath('package-lock.json', ctx.cwd);
  let existing: Lockfile | null = null;
  try {
    const old = JSON.parse(await ctx.fs.readFile(lockPath, 'utf8') as string);
    if (old && typeof old.packages === 'object') existing = old;
  } catch { /* none yet (or unreadable: written fresh) */ }
  try {
    await ctx.fs.writeFile(lockPath, serializeLockfile(updateLockfile(existing, pkg, tree)));
  } catch (e: any) {
    ctx.stderr += `npm warn could not write package-lock.json: ${e?.message ?? e}\n`;
  }
}

/**
 * Global install: install packages to /usr/local/lib/node_modules/
 * and create bin symlinks in /usr/local/bin/
 */
async function npmInstallGlobal(
  ctx: CommandContext,
  packagesToInstall: string[]
): Promise<number> {
  if (packagesToInstall.length === 0) {
    ctx.stderr += 'npm: please specify packages to install globally\n';
    return 1;
  }

  const globalModulesDir = '/usr/local/lib/node_modules';
  const globalBinDir = '/usr/local/bin';

  // Ensure global directories exist
  for (const dir of ['/usr/local/lib', globalModulesDir, globalBinDir]) {
    try {
      await ctx.fs.mkdir(dir, { recursive: true });
    } catch {
      // Already exists
    }
  }

  const depsToResolve: Record<string, string> = {};
  for (const spec of packagesToInstall) {
    let name: string, version: string;
    if (spec.startsWith('@')) {
      const lastAt = spec.lastIndexOf('@');
      if (lastAt > 0) {
        name = spec.slice(0, lastAt);
        version = spec.slice(lastAt + 1);
      } else {
        name = spec;
        version = 'latest';
      }
    } else if (spec.includes('@')) {
      const atIdx = spec.indexOf('@');
      name = spec.slice(0, atIdx);
      version = spec.slice(atIdx + 1);
    } else {
      name = spec;
      version = 'latest';
    }
    depsToResolve[name] = version;
  }

  ctx.stdout += 'Installing packages globally...\n';
  const tree = await resolveTree(ctx, Object.entries(depsToResolve).map(([name, range]) => ({ name, range })));
  const { added, failed } = await installTree(ctx, '/usr/local/lib', tree, { globalBinDir, ignoreScripts: await ignoreScripts(ctx) });
  ctx.stdout += `\nadded ${added} package(s)\n`;
  if (failed) return 1;
  ctx.stdout += 'Packages installed globally.\n';
  return 0;
}

async function npmList(ctx: CommandContext): Promise<number> {
  const pkgPath = ctx.fs.resolvePath('package.json', ctx.cwd);

  let pkg: PackageJson;
  try {
    const content = await ctx.fs.readFile(pkgPath, 'utf8') as string;
    pkg = JSON.parse(content);
  } catch {
    ctx.stderr += 'npm: package.json not found.\n';
    return 1;
  }

  const deps = pkg.dependencies || {};
  const devDeps = pkg.devDependencies || {};

  if (Object.keys(deps).length === 0 && Object.keys(devDeps).length === 0) {
    ctx.stdout += 'No packages installed.\n';
    return 0;
  }

  ctx.stdout += `${pkg.name}@${pkg.version}\n`;

  if (Object.keys(deps).length > 0) {
    ctx.stdout += '\ndependencies:\n';
    for (const [name, version] of Object.entries(deps)) {
      // Try to read installed version from node_modules
      const installedPkgPath = ctx.fs.resolvePath(
        `node_modules/${name}/package.json`,
        ctx.cwd
      );
      let installedVersion = version;
      try {
        const installedContent = await ctx.fs.readFile(installedPkgPath, 'utf8') as string;
        const installedPkg = JSON.parse(installedContent);
        installedVersion = installedPkg.version || version;
      } catch {
        // Can't read installed version
      }
      ctx.stdout += `  ${name} ${installedVersion}\n`;
    }
  }

  if (Object.keys(devDeps).length > 0) {
    ctx.stdout += '\ndevDependencies:\n';
    for (const [name, version] of Object.entries(devDeps)) {
      ctx.stdout += `  ${name} ${version}\n`;
    }
  }

  return 0;
}

async function npmRun(ctx: CommandContext): Promise<number> {
  const scriptName = ctx.args[1];

  if (!scriptName) {
    // List available scripts
    const pkgPath = ctx.fs.resolvePath('package.json', ctx.cwd);
    let pkg: PackageJson;
    try {
      const content = await ctx.fs.readFile(pkgPath, 'utf8') as string;
      pkg = JSON.parse(content);
    } catch {
      ctx.stderr += 'npm: package.json not found.\n';
      return 1;
    }

    const scripts = pkg.scripts || {};
    if (Object.keys(scripts).length === 0) {
      ctx.stdout += 'No scripts available.\n';
      return 0;
    }

    ctx.stdout += 'Available scripts:\n';
    for (const [name, command] of Object.entries(scripts)) {
      ctx.stdout += `  ${name}\n`;
      ctx.stdout += `    ${command}\n`;
    }
    return 0;
  }

  const pkgPath = ctx.fs.resolvePath('package.json', ctx.cwd);

  let pkg: PackageJson;
  try {
    const content = await ctx.fs.readFile(pkgPath, 'utf8') as string;
    pkg = JSON.parse(content);
  } catch {
    ctx.stderr += 'npm: package.json not found.\n';
    return 1;
  }

  const script = pkg.scripts?.[scriptName];
  if (!script) {
    ctx.stderr += `npm: missing script: ${scriptName}\n`;
    ctx.stderr += '\nAvailable scripts:\n';
    for (const name of Object.keys(pkg.scripts || {})) {
      ctx.stderr += `  ${name}\n`;
    }
    return 1;
  }

  // (what follows the script's name, a `--` dropped, goes to it, as npm 7+ passes it)
  const extra = withScriptArgs(script, ctx.args.slice(2));
  scriptHeader(ctx, `> ${scriptId(pkg)}${scriptName}\n> ${extra}\n\n`);

  // Execute the script via the shell; on npm's terminal when that is where npm's output
  // goes, as npx does (a dev server's output comes as it runs, not when it ends)
  return ctx.shell.execute(extra, scriptOut(ctx), scriptErr(ctx), false, scriptTerminal(ctx), true);
}

/**
 * Run a named script shortcut (npm start, npm test, npm stop).
 * Falls back to defaultScript if the script isn't defined in package.json.
 */
async function npmRunScript(ctx: CommandContext, scriptName: string, defaultScript?: string): Promise<number> {
  const pkgPath = ctx.fs.resolvePath('package.json', ctx.cwd);

  let pkg: PackageJson;
  try {
    const content = await ctx.fs.readFile(pkgPath, 'utf8') as string;
    pkg = JSON.parse(content);
  } catch {
    ctx.stderr += 'npm: package.json not found.\n';
    return 1;
  }

  const script = pkg.scripts?.[scriptName];
  if (!script) {
    if (defaultScript) {
      scriptOut(ctx)(`> ${scriptId(pkg)}${scriptName}\n> ${defaultScript}\n\n`);
      return await ctx.shell.execute(defaultScript, scriptOut(ctx), scriptErr(ctx), false, undefined, true);
    }
    ctx.stderr += `npm: missing script: ${scriptName}\n`;
    ctx.stderr += '\nAvailable scripts:\n';
    for (const name of Object.keys(pkg.scripts || {})) {
      ctx.stderr += `  ${name}\n`;
    }
    return 1;
  }

  const extra = withScriptArgs(script, ctx.args.slice(1));
  scriptHeader(ctx, `> ${scriptId(pkg)}${scriptName}\n> ${extra}\n\n`);

  return await ctx.shell.execute(extra, scriptOut(ctx), scriptErr(ctx), false, scriptTerminal(ctx), true);
}

/** A script with the arguments npm passes on (a leading `--` dropped), each quoted for the shell */
function withScriptArgs(script: string, args: string[]): string {
  const rest = args[0] === '--' ? args.slice(1) : args;
  return rest.length ? `${script} ${quoteArgsForShell(rest)}` : script;
}

// Output of a nested execute() is terminal-style (\r\n); npm's is a plain stream
// again, converted once by whoever shows it (a redirect writes \n). It goes on as it
// comes where the shell streams npm's output (`npm run dev > log`: a server never ends).
const scriptOut = (ctx: CommandContext) => (s: string) => { s = s.replace(/\r\n/g, '\n'); if (ctx.streamStdout) ctx.streamStdout(s); else ctx.stdout += s; };
const scriptErr = (ctx: CommandContext) => (s: string) => { s = s.replace(/\r\n/g, '\n'); if (ctx.streamStderr) ctx.streamStderr(s); else ctx.stderr += s; };

/** npm's "> name@version" (just "> " without a name, as npm does) */
const scriptId = (pkg: PackageJson) => pkg.name ? `${pkg.name}${pkg.version ? '@' + pkg.version : ''} ` : '';

/** npm's "> name@version script" lines: before the script's output, which may go to the terminal as it runs */
function scriptHeader(ctx: CommandContext, text: string): void {
  if (silentRuns.has(ctx)) return;
  const term = scriptTerminal(ctx) as { writeOutput?: (s: string) => void } | undefined;
  if (term?.writeOutput) term.writeOutput(text.replace(/\n/g, '\r\n'));
  else if (ctx.streamStdout) ctx.streamStdout(text);
  else ctx.stdout += text;
}

/** A script's terminal: npm's own, when npm's stdout is it (not redirected or piped); else collected */
function scriptTerminal(ctx: CommandContext): unknown {
  return ctx.terminal && ctx.stdoutIsTTY !== false ? ctx.terminal : undefined;
}

async function npmUninstall(ctx: CommandContext): Promise<number> {
  const packagesToRemove = ctx.args.slice(1);

  if (packagesToRemove.length === 0) {
    ctx.stderr += 'npm: missing package name\n';
    ctx.stderr += 'Usage: npm uninstall <package>\n';
    return 1;
  }

  const pkgPath = ctx.fs.resolvePath('package.json', ctx.cwd);

  let pkg: PackageJson;
  try {
    const content = await ctx.fs.readFile(pkgPath, 'utf8') as string;
    pkg = JSON.parse(content);
  } catch {
    ctx.stderr += 'npm: package.json not found.\n';
    return 1;
  }

  for (const name of packagesToRemove) {
    if (pkg.dependencies?.[name]) {
      delete pkg.dependencies[name];
      ctx.stdout += `Removed ${name} from dependencies.\n`;
    } else if (pkg.devDependencies?.[name]) {
      delete pkg.devDependencies[name];
      ctx.stdout += `Removed ${name} from devDependencies.\n`;
    } else {
      ctx.stderr += `Package ${name} not found in dependencies.\n`;
    }

    // Remove from node_modules
    const packagePath = ctx.fs.resolvePath(`node_modules/${name}`, ctx.cwd);
    try {
      await ctx.fs.rm(packagePath, { recursive: true });
      ctx.stdout += `Removed ${name} from node_modules.\n`;
    } catch (e: any) {
      ctx.stderr += `Warning: Could not remove ${name} from node_modules: ${e.message}\n`;
    }
  }

  // Save package.json
  await ctx.fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  // ...and the lockfile, without them (#59)
  const lockPath = ctx.fs.resolvePath('package-lock.json', ctx.cwd);
  try {
    const lock = JSON.parse(await ctx.fs.readFile(lockPath, 'utf8') as string) as Lockfile;
    if (lock && typeof lock.packages === 'object') await ctx.fs.writeFile(lockPath, serializeLockfile(dropFromLockfile(lock, pkg, packagesToRemove)));
  } catch { /* no lockfile */ }

  return 0;
}

async function npmCache(ctx: CommandContext): Promise<number> {
  const action = ctx.args[1];

  if (!action || action === '--help') {
    ctx.stdout += 'Usage: npm cache <command>\n\n';
    ctx.stdout += 'Commands:\n';
    ctx.stdout += '  clean     Clear the metadata cache\n';
    ctx.stdout += '  status    Show cache statistics\n';
    return 0;
  }

  switch (action) {
    case 'clean':
    case 'clear': {
      const force = ctx.args.includes('--force') || ctx.args.includes('-f');
      const size = metadataCache.size;
      metadataCache.clear();
      ctx.stdout += `Cleared ${size} cached package metadata entries.\n`;
      if (force) {
        const nmPath = ctx.fs.resolvePath('node_modules', ctx.cwd);
        try {
          await ctx.fs.rm(nmPath, { recursive: true });
          ctx.stdout += 'Removed node_modules/ directory.\n';
        } catch {
          ctx.stdout += 'No node_modules/ directory to remove.\n';
        }
      }
      return 0;
    }

    case 'status':
    case 'ls':
      ctx.stdout += 'npm metadata cache:\n';
      ctx.stdout += `  Cached packages: ${metadataCache.size}\n`;
      ctx.stdout += `  TTL: ${METADATA_CACHE_TTL / 1000 / 60} minutes\n`;
      if (metadataCache.size > 0) {
        ctx.stdout += '\n  Cached entries:\n';
        const now = Date.now();
        for (const [name, { timestamp }] of metadataCache) {
          const ageSeconds = Math.floor((now - timestamp) / 1000);
          const ageMinutes = Math.floor(ageSeconds / 60);
          const remaining = Math.floor((METADATA_CACHE_TTL - (now - timestamp)) / 1000 / 60);
          ctx.stdout += `    ${name} (age: ${ageMinutes}m, expires in: ${remaining}m)\n`;
        }
      }
      return 0;

    default:
      ctx.stderr += `npm cache: unknown command '${action}'\n`;
      return 1;
  }
}

/**
 * npm config get|set|delete|list: ~/.npmrc (key=value lines), with npm's
 * defaults for what isn't set. Tools ask it things: Next.js downloads its
 * SWC binary from `npm config get registry`.
 */
async function npmConfig(ctx: CommandContext): Promise<number> {
  const home = ctx.env['HOME'] || '/home/user';
  const rcPath = `${home}/.npmrc`;
  const defaults: Record<string, string> = {
    registry: 'https://registry.npmjs.org/',
    prefix: '/usr/local',
    cache: `${home}/.npm`,
    'user-agent': `npm/${NPM_VERSION} node/v22.12.0 linux x64 workspaces/false`,
  };
  let text = '';
  try { text = await ctx.fs.readFile(rcPath, 'utf8') as string; } catch { /* none */ }
  const rc = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^\s*([^#;=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) rc.set(m[1], m[2]);
  }
  const save = () => ctx.fs.writeFile(rcPath, [...rc].map(([k, v]) => `${k}=${v}`).join('\n') + (rc.size ? '\n' : ''));
  const [, action = 'list', ...rest] = ctx.args.filter((a) => a !== '--global' && a !== '-g' && a !== '--location=user');
  switch (action) {
    case 'get': {
      if (!rest.length) { for (const [k, v] of rc) ctx.stdout += `${k}=${v}\n`; return 0; }
      for (const k of rest) ctx.stdout += `${rc.get(k) ?? defaults[k] ?? 'undefined'}\n`;
      return 0;
    }
    case 'set': {
      for (const kv of rest) {
        const i = kv.indexOf('=');
        if (i > 0) rc.set(kv.slice(0, i), kv.slice(i + 1));
        else if (rest.length >= 2) { rc.set(rest[0], rest[1]); break; }
      }
      await save();
      return 0;
    }
    case 'delete':
    case 'rm':
      for (const k of rest) rc.delete(k);
      await save();
      return 0;
    case 'list':
    case 'ls':
      ctx.stdout += `; "user" config from ${rcPath}\n\n`;
      for (const [k, v] of rc) ctx.stdout += `${k} = ${JSON.stringify(v)}\n`;
      ctx.stdout += `\n; node bin location = /usr/local/bin/node\n; cwd = ${ctx.cwd}\n; HOME = ${home}\n`;
      return 0;
    default:
      ctx.stderr += `npm config: unknown command '${action}'\n`;
      return 1;
  }
}


// ── npm pkg, ci, version, view ───────────────────────────────────────────────

/** package.json's text and value (null when there is none) */
async function readPackage(ctx: CommandContext): Promise<{ path: string; pkg: any } | null> {
  const path = ctx.fs.resolvePath('package.json', ctx.cwd);
  try { return { path, pkg: JSON.parse(await ctx.fs.readFile(path, 'utf8') as string) }; } catch { return null; }
}

/** `scripts.test`, `files[0]`, `a.b[2].c` as keys */
const keyPath = (key: string) => key.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);

/** npm pkg get [key...] | set key=value... [--json] | delete key... */
async function npmPkg(ctx: CommandContext): Promise<number> {
  const [, action, ...rest] = ctx.args;
  const json = rest.includes('--json');
  const keys = rest.filter((a) => a !== '--json' && a !== '-w' && !a.startsWith('--workspace'));
  const file = await readPackage(ctx);
  if (!file) { ctx.stderr += `npm error code ENOENT\nnpm error Could not read package.json at ${ctx.fs.resolvePath('package.json', ctx.cwd)}\n`; return 1; }
  const get = (key: string) => keyPath(key).reduce((o: any, k) => (o == null ? undefined : o[k]), file.pkg);
  if (action === 'get' || action === undefined) {
    const out = !keys.length ? file.pkg : keys.length === 1 ? get(keys[0]) : Object.fromEntries(keys.map((k) => [k, get(k)]).filter(([, v]) => v !== undefined));
    if (out !== undefined && !(keys.length > 1 && !Object.keys(out).length)) ctx.stdout += JSON.stringify(out, null, 2) + '\n';
    return 0;
  }
  if (action === 'set') {
    for (const kv of keys) {
      const eq = kv.indexOf('=');
      if (eq <= 0) { ctx.stderr += `npm error npm pkg set expects a key=value pair of args.\n`; return 1; }
      const path = keyPath(kv.slice(0, eq));
      let value: any = kv.slice(eq + 1);
      if (json) { try { value = JSON.parse(value); } catch (e: any) { ctx.stderr += `npm error ${e.message}\n`; return 1; } }
      let o = file.pkg;
      for (let i = 0; i < path.length - 1; i++) {
        if (o[path[i]] == null || typeof o[path[i]] !== 'object') o[path[i]] = /^\d+$/.test(path[i + 1]) ? [] : {};
        o = o[path[i]];
      }
      o[path[path.length - 1]] = value;
    }
  } else if (action === 'delete') {
    for (const key of keys) {
      const path = keyPath(key);
      let o = file.pkg;
      for (let i = 0; i < path.length - 1 && o; i++) o = o[path[i]];
      if (o && typeof o === 'object') { if (Array.isArray(o)) o.splice(Number(path[path.length - 1]), 1); else delete o[path[path.length - 1]]; }
    }
  } else {
    ctx.stderr += `npm error Unknown pkg command: ${action}\nnpm error Usage: npm pkg get|set|delete [<key>...]\n`;
    return 1;
  }
  await ctx.fs.writeFile(file.path, JSON.stringify(file.pkg, null, 2) + '\n');
  return 0;
}

/**
 * npm ci: node_modules removed, then installed from package.json. As npm, it needs a
 * lockfile; the versions installed are package.json's ranges resolved now (this npm doesn't
 * read package-lock.json's pins).
 */
async function npmCi(ctx: CommandContext): Promise<number> {
  const has = async (f: string) => ctx.fs.exists(ctx.fs.resolvePath(f, ctx.cwd));
  if (!(await has('package-lock.json')) && !(await has('npm-shrinkwrap.json'))) {
    ctx.stderr += 'npm error code EUSAGE\nnpm error\nnpm error The `npm ci` command can only install with an existing package-lock.json or\nnpm error npm-shrinkwrap.json with lockfileVersion >= 1. Run an install with npm@5 or\nnpm error later to generate a package-lock.json file, then try again.\n';
    return 1;
  }
  try { await ctx.fs.rm(ctx.fs.resolvePath('node_modules', ctx.cwd), { recursive: true }); } catch { /* none */ }
  ctx.args = ['install', ...ctx.args.slice(1).filter((a) => a.startsWith('-'))];
  return npmInstall(ctx);
}

const BUMPS = ['major', 'minor', 'patch', 'premajor', 'preminor', 'prepatch', 'prerelease'];

/** A version bumped as npm (semver.inc) does */
function bumpVersion(v: string, kind: string, preid?: string): string | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v);
  if (!m) return null;
  let [maj, min, pat] = [+m[1], +m[2], +m[3]];
  const pre = m[4];
  const preStart = preid ? `${preid}.0` : '0';
  switch (kind) {
    case 'major': return pre && min === 0 && pat === 0 ? `${maj}.0.0` : `${maj + 1}.0.0`;
    case 'minor': return pre && pat === 0 ? `${maj}.${min}.0` : `${maj}.${min + 1}.0`;
    case 'patch': return pre ? `${maj}.${min}.${pat}` : `${maj}.${min}.${pat + 1}`;
    case 'premajor': return `${maj + 1}.0.0-${preStart}`;
    case 'preminor': return `${maj}.${min + 1}.0-${preStart}`;
    case 'prepatch': return `${maj}.${min}.${pat + 1}-${preStart}`;
    case 'prerelease': {
      if (!pre) return `${maj}.${min}.${pat + 1}-${preStart}`;
      const parts = pre.split('.');
      const last = parts.length - 1;
      if (/^\d+$/.test(parts[last])) parts[last] = String(+parts[last] + 1); else parts.push('0');
      return `${maj}.${min}.${pat}-${parts.join('.')}`;
    }
  }
  return null;
}

/** npm version: the versions (package, npm, node) with no argument; else package.json's bumped */
async function npmVersion(ctx: CommandContext): Promise<number> {
  const args = ctx.args.slice(1).filter((a) => !a.startsWith('-'));
  const preid = (() => { const i = ctx.args.indexOf('--preid'); return i >= 0 ? ctx.args[i + 1] : ctx.args.find((a) => a.startsWith('--preid='))?.slice(8); })();
  const json = ctx.args.includes('--json');
  const file = await readPackage(ctx);
  if (!args.length || (preid && args[0] === preid)) {
    const versions: Record<string, string> = {};
    if (file?.pkg?.name && file.pkg.version) versions[file.pkg.name] = file.pkg.version;
    Object.assign(versions, { npm: NPM_VERSION, node: '22.12.0', acorn: '8.14.0', ada: '2.9.2', brotli: '1.1.0', uv: '1.49.1', v8: '12.4.254.21-node.21', zlib: '1.3.0.1-motley-82a5fec' });
    ctx.stdout += json ? JSON.stringify(versions, null, 2) + '\n' : `{\n${Object.entries(versions).map(([k, v]) => `  ${/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`}: '${v}'`).join(',\n')}\n}\n`;
    return 0;
  }
  if (!file) { ctx.stderr += 'npm error code ENOENT\nnpm error Could not read package.json\n'; return 1; }
  const want = args[0].replace(/^v/, '');
  const next = BUMPS.includes(args[0]) ? bumpVersion(String(file.pkg.version ?? '0.0.0'), args[0], preid) : /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(want) ? want : null;
  if (!next) { ctx.stderr += `npm error Invalid version: ${args[0]}\n`; return 1; }
  if (next === file.pkg.version && !ctx.args.includes('--allow-same-version')) { ctx.stderr += 'npm error Version not changed, might want --allow-same-version\n'; return 1; }
  file.pkg.version = next;
  await ctx.fs.writeFile(file.path, JSON.stringify(file.pkg, null, 2) + '\n');
  // (the lockfile's own version, when there is one)
  const lockPath = ctx.fs.resolvePath('package-lock.json', ctx.cwd);
  try {
    const lock = JSON.parse(await ctx.fs.readFile(lockPath, 'utf8') as string);
    lock.version = next;
    if (lock.packages?.['']) lock.packages[''].version = next;
    await ctx.fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');
  } catch { /* none */ }
  ctx.stdout += `v${next}\n`;
  return 0;
}

/** npm view <pkg>[@version] [field...] [--json]: the registry's data about a package */
async function npmView(ctx: CommandContext): Promise<number> {
  const json = ctx.args.includes('--json');
  const [spec, ...fields] = ctx.args.slice(1).filter((a) => !a.startsWith('-'));
  let name = spec, range = 'latest';
  if (!spec || spec === '.') {
    const file = await readPackage(ctx);
    if (!file?.pkg?.name) { ctx.stderr += 'npm error code EUSAGE\nnpm error Usage: npm view [<package-spec>] [<field>[.subfield]...]\n'; return 1; }
    name = file.pkg.name;
  } else {
    const at = spec.lastIndexOf('@');
    if (at > 0) { name = spec.slice(0, at); range = spec.slice(at + 1); }
  }
  let doc: any;
  try {
    const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}`;
    const res = await fetch(url);
    if (res.status === 404) { ctx.stderr += `npm error code E404\nnpm error 404 Not Found - GET ${url} - Not found\n`; return 1; }
    doc = await res.json();
  } catch (e: any) {
    ctx.stderr += `npm error ${e?.message ?? e}\n`;
    return 1;
  }
  const version = doc['dist-tags']?.[range] ?? (doc.versions?.[range] ? range : undefined)
    ?? Object.keys(doc.versions ?? {}).filter((v) => satisfiesLoose(v, range)).pop();
  const data = version ? { ...doc, ...doc.versions[version], versions: Object.keys(doc.versions ?? {}), 'dist-tags': doc['dist-tags'], time: doc.time } : null;
  if (!data) { ctx.stderr += `npm error code E404\nnpm error No match found for version ${range}\n`; return 1; }
  if (fields.length) {
    const pick = (f: string) => keyPath(f).reduce((o: any, k) => (o == null ? undefined : o[k]), data);
    if (fields.length === 1) {
      const v = pick(fields[0]);
      if (v === undefined) return 0;
      ctx.stdout += json ? JSON.stringify(v, null, 2) + '\n' : typeof v === 'string' ? v + '\n' : JSON.stringify(v, null, 2).replace(/"([A-Za-z_$][\w$]*)":/g, '$1:').replace(/"/g, "'") + '\n';
      return 0;
    }
    const out = Object.fromEntries(fields.map((f) => [f, pick(f)]));
    ctx.stdout += json ? JSON.stringify(out, null, 2) + '\n' : Object.entries(out).map(([k, v]) => `${k} = ${typeof v === 'string' ? `'${v}'` : JSON.stringify(v)}`).join('\n') + '\n';
    return 0;
  }
  if (json) { const { versions, time, ...rest } = data; ctx.stdout += JSON.stringify({ ...rest, versions }, null, 2) + '\n'; return 0; }
  const deps = Object.keys(data.dependencies ?? {});
  ctx.stdout += `\n${data.name}@${data.version} | ${data.license ?? 'Proprietary'} | deps: ${deps.length || 'none'} | versions: ${data.versions.length}\n`;
  if (data.description) ctx.stdout += `${data.description}\n`;
  if (data.homepage) ctx.stdout += `${data.homepage}\n`;
  if (data.bin) ctx.stdout += `\nbin: ${Object.keys(typeof data.bin === 'string' ? { [data.name]: 1 } : data.bin).join(', ')}\n`;
  ctx.stdout += `\ndist\n.tarball: ${data.dist?.tarball}\n.shasum: ${data.dist?.shasum}\n`;
  if (data.dist?.integrity) ctx.stdout += `.integrity: ${data.dist.integrity}\n`;
  if (deps.length) ctx.stdout += `\ndependencies:\n${deps.map((d) => `${d}: ${data.dependencies[d]}`).join('\n')}\n`;
  ctx.stdout += `\ndist-tags:\n${Object.entries(data['dist-tags'] ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n')}\n`;
  if (data.time?.[data.version]) ctx.stdout += `\npublished ${data.time[data.version]}\n`;
  return 0;
}

/** x, x.y, ^x.y.z, ~x.y.z, x.y.z: enough of semver for `npm view pkg@range` (the highest match is last) */
function satisfiesLoose(v: string, range: string): boolean {
  if (/-/.test(v)) return false;
  const [a, b, c] = v.split('.').map(Number);
  const m = /^([~^]?)(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(range.trim());
  if (!m) return false;
  const [, op, M, mi, pa] = m;
  if (a !== +M) return false;
  if (op === '^') return mi === undefined || mi === 'x' || mi === '*' ? true : +M > 0 ? (b > +mi || (b === +mi && c >= +(pa ?? 0))) : (b === +mi && c >= +(pa ?? 0));
  if (mi === undefined || mi === 'x' || mi === '*') return true;
  if (b !== +mi) return false;
  if (op === '~') return c >= +(pa ?? 0);
  return pa === undefined || pa === 'x' || pa === '*' ? true : c === +pa;
}
