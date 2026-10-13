/**
 * Source distributions and a PyPI JSON index made in memory, for the pip
 * tests (pip-sdist.test.ts, python-cpython.test.ts).
 */
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

/** A .tar.gz (ustar) of `files`, all under `top/`. */
export function makeTarGz(top: string, files: Record<string, string>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [rel, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const h = Buffer.alloc(512);
    h.write(`${top}/${rel}`, 0, 100);
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0' + '00', 257);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(blocks)));
}

export interface FakeRelease {
  name: string;
  version: string;
  /** the sdist's files, below its top directory */
  sdist: Record<string, string>;
  /** names of wheels the release also has (never downloaded: other platforms') */
  otherWheels?: string[];
  requires?: string[];
}

export const pkgInfo = (name: string, version: string, requires: string[] = []) =>
  `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\nSummary: ${name} for tests\n` + requires.map((r) => `Requires-Dist: ${r}\n`).join('');

/** PyPI's JSON API and sdist files for `releases`; `fetched` lists the URLs asked for. */
export function fakeSdistIndex(releases: FakeRelease[]): { fetch: typeof fetch; fetched: string[] } {
  const files = new Map<string, Uint8Array>();
  const projects = new Map<string, any>();
  for (const r of releases) {
    const norm = r.name.toLowerCase().replace(/[-_.]+/g, '-');
    const filename = `${norm.replace(/-/g, '_')}-${r.version}.tar.gz`;
    const bytes = makeTarGz(`${norm.replace(/-/g, '_')}-${r.version}`, { 'PKG-INFO': pkgInfo(r.name, r.version, r.requires), ...r.sdist });
    const url = `https://files.example/${filename}`;
    files.set(url, bytes);
    const info = { name: r.name, version: r.version, requires_dist: r.requires ?? [] };
    const p = projects.get(norm) ?? { info, releases: {}, perVersion: {} };
    p.releases[r.version] = [
      { filename, url, packagetype: 'sdist', size: bytes.length, digests: { sha256: createHash('sha256').update(bytes).digest('hex') } },
      ...(r.otherWheels ?? []).map((w) => ({ filename: w, url: `https://files.example/${w}`, packagetype: 'bdist_wheel' })),
    ];
    p.perVersion[r.version] = { info };
    p.info = info; // (releases are given oldest first)
    projects.set(norm, p);
  }
  const fetched: string[] = [];
  const fetchFn = (async (input: any) => {
    const url = String(input);
    fetched.push(url);
    const f = files.get(url);
    if (f) return new Response(f);
    const m = /^https:\/\/pypi\.org\/pypi\/([^/]+)\/(?:([^/]+)\/)?json$/.exec(url);
    const p = m && projects.get(m[1]);
    if (!p) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(m![2] ? p.perVersion[m![2]] : { info: p.info, releases: p.releases }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fetchFn, fetched };
}

/** MarkupSafe's layout: src/, an egg-info, the extension tried first and a Python fallback. */
export const SAFEMARK: FakeRelease = {
  name: 'SafeMark', version: '3.0.4',
  otherWheels: ['safemark-3.0.4-cp313-cp313-manylinux_2_28_x86_64.whl', 'safemark-3.0.4-cp313-cp313-win_amd64.whl'],
  sdist: {
    'pyproject.toml': '[build-system]\nrequires = ["setuptools>=70.1"]\nbuild-backend = "setuptools.build_meta"\n',
    'setup.py': 'from setuptools import Extension, setup\nsetup(ext_modules=[Extension("safemark._speedups", ["src/safemark/_speedups.c"])])\n',
    'src/SafeMark.egg-info/top_level.txt': 'safemark\n',
    'src/SafeMark.egg-info/PKG-INFO': pkgInfo('SafeMark', '3.0.4'),
    'src/safemark/__init__.py': 'try:\n    from ._speedups import escape\n    FAST = True\nexcept ImportError:\n    from ._native import escape\n    FAST = False\n',
    'src/safemark/_native.py': 'def escape(s):\n    return s.replace("&", "&amp;").replace("<", "&lt;")\n',
    'src/safemark/_speedups.c': '#include <Python.h>\n',
    'src/safemark/_speedups.pyi': 'def escape(s: str) -> str: ...\n',
    'src/safemark/py.typed': '',
    'tests/test_escape.py': 'def test(): pass\n',
  },
};
