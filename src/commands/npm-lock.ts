/**
 * What `npm install` writes besides node_modules (#59): the range it saves
 * in package.json, and package-lock.json (lockfileVersion 3).
 *
 * The saved range follows npm (@npmcli/arborist reify): the save prefix and
 * the version installed (`^1.1.1`), unless what was asked for is a range
 * that `^<installed>` isn't inside (`1.x <1.2.3` stays as written). Tags
 * (`latest`, `next`) and exact versions save with the prefix; --save-exact
 * saves the version alone.
 *
 * The lockfile has npm's layout: `packages[""]` is the project, every other
 * key the path a package is installed at (`node_modules/a/node_modules/b`)
 * with its version, tarball, integrity and dependencies; a package only the
 * dev dependencies need is `dev: true`. An install of a few packages
 * resolves only those, so their entries are merged into the lockfile there.
 */
import { satisfiesRange, parseSemVer } from '../utils/semver-utils';
import type { BuildResult, TreeNode } from './npm-tree';

export const SAVE_PREFIX = '^';

/** An exact version (1.2.3, 1.2.3-beta.1), not a range or a tag */
const isVersion = (s: string) => /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/.test(s.trim());
/** A semver range (^1.2, ~1, 1.x, >=1 <2, 1 - 2, *, ||): not a tag like latest */
export const isRange = (s: string) => {
  const r = s.trim();
  return r === '' || r === '*' || (!isVersion(r) && /^[\s\d.xX*^~<>=|v-]+$/.test(r));
};

/**
 * Is every version `^version` allows inside `range`? Checked at the ends of
 * `^version`'s span (its lowest, a patch and a minor above, the highest
 * below the next breaking release): enough for the ranges people write.
 */
function caretInside(version: string, range: string): boolean {
  const v = parseSemVer(version);
  if (!v) return false;
  const probes = v.major > 0
    ? [`${v.major}.${v.minor}.${v.patch}`, `${v.major}.${v.minor}.${v.patch + 1}`, `${v.major}.${v.minor + 1}.0`, `${v.major}.999999.999999`]
    : v.minor > 0
      ? [`0.${v.minor}.${v.patch}`, `0.${v.minor}.${v.patch + 1}`, `0.${v.minor}.999999`]
      : [`0.0.${v.patch}`];
  return probes.every((p) => satisfiesRange(p, range));
}

/** What package.json gets for `requested` (as typed after name@; '' or latest for a bare name) installed as `version` */
export function saveSpec(requested: string, version: string, opts: { exact?: boolean; prefix?: string } = {}): string {
  if (opts.exact) return version;
  const prefixed = (opts.prefix ?? SAVE_PREFIX) + version;
  const req = requested.trim();
  if (!isRange(req) || req === '' || req === '*' || caretInside(version, req)) return prefixed;
  return req;
}

/** A tarball's integrity as the lockfile records it: the registry's, else sha1 from its shasum (old packages) */
export function integrityOf(dist: { integrity?: string; shasum?: string } | undefined): string | undefined {
  if (dist?.integrity) return dist.integrity;
  if (dist?.shasum && /^[0-9a-f]{40}$/i.test(dist.shasum)) {
    const bytes = dist.shasum.match(/../g)!.map((h) => parseInt(h, 16));
    return 'sha1-' + btoa(String.fromCharCode(...bytes));
  }
  return undefined;
}

export interface Lockfile {
  name?: string;
  version?: string;
  lockfileVersion: 3;
  requires: true;
  packages: Record<string, Record<string, unknown>>;
}

interface ProjectJson {
  name?: string; version?: string;
  dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
}

/** The lockfile entry of one installed package */
function entryOf(n: TreeNode, dev: boolean): Record<string, unknown> {
  const d = n.data;
  const e: Record<string, unknown> = {};
  if (n.source && n.source !== n.name) e.name = n.source; // (an alias's or WebAssembly alternate's package)
  e.version = n.version;
  e.resolved = n.tarball;
  const integrity = integrityOf(d?.dist);
  if (integrity) e.integrity = integrity;
  if (dev) e.dev = true;
  if (d?.dependencies && Object.keys(d.dependencies).length) e.dependencies = { ...d.dependencies };
  if (d?.optionalDependencies && Object.keys(d.optionalDependencies).length) e.optionalDependencies = { ...d.optionalDependencies };
  if (d?.peerDependencies && Object.keys(d.peerDependencies).length) e.peerDependencies = { ...d.peerDependencies };
  if (d?.bin) e.bin = typeof d.bin === 'string' ? { [n.name.replace(/^@[^/]+\//, '')]: d.bin } : { ...d.bin };
  return e;
}

/**
 * package-lock.json after an install of `tree` in a project whose package.json
 * is now `pkg`: `existing` (the lockfile there, if any) with the tree's
 * packages put in, and the project entry from package.json.
 */
export function updateLockfile(existing: Lockfile | null, pkg: ProjectJson, tree: BuildResult): Lockfile {
  // What the project's own (non-dev) dependencies reach; the rest of this tree is dev-only
  const prodRoots = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]);
  const prod = new Set<TreeNode>();
  const reach = (n: TreeNode) => { if (prod.has(n)) return; prod.add(n); for (const d of n.resolved.values()) reach(d); };
  for (const [name, n] of tree.root.resolved) if (prodRoots.has(name)) reach(n);

  const packages: Record<string, Record<string, unknown>> = { ...(existing?.packages ?? {}) };
  const project: Record<string, unknown> = {};
  if (pkg.name) project.name = pkg.name;
  if (pkg.version) project.version = pkg.version;
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    if (pkg[k] && Object.keys(pkg[k]!).length) project[k] = { ...pkg[k] };
  }
  packages[''] = project;
  for (const n of tree.nodes) {
    let dev = !prod.has(n);
    // (still needed by the project's dependencies an earlier install locked here)
    if (dev && packages[n.dir] && !packages[n.dir].dev && packages[n.dir].version === n.version) dev = false;
    packages[n.dir] = entryOf(n, dev);
  }
  const sorted: Record<string, Record<string, unknown>> = { '': packages[''] };
  for (const k of Object.keys(packages).filter((k) => k !== '').sort()) sorted[k] = packages[k];
  return {
    ...(pkg.name ? { name: pkg.name } : {}),
    ...(pkg.version ? { version: pkg.version } : {}),
    lockfileVersion: 3,
    requires: true,
    packages: sorted,
  };
}

/** The lockfile after `npm uninstall name...`: their entries (and what's installed under them) go */
export function dropFromLockfile(lock: Lockfile, pkg: ProjectJson, names: string[]): Lockfile {
  const packages = { ...lock.packages };
  for (const name of names) {
    for (const k of Object.keys(packages)) if (k === `node_modules/${name}` || k.startsWith(`node_modules/${name}/`)) delete packages[k];
  }
  const project = { ...(packages[''] ?? {}) };
  for (const k of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    if (pkg[k] && Object.keys(pkg[k]!).length) project[k] = { ...pkg[k] }; else delete project[k];
  }
  packages[''] = project;
  return { ...lock, packages };
}

export const serializeLockfile = (lock: Lockfile) => JSON.stringify(lock, null, 2) + '\n';
