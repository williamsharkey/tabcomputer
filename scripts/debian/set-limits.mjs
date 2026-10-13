#!/usr/bin/env node
// Package layers (docs/DEBIAN.md "Package layers"): what a requested set may
// install, checked before anything is installed. Reads the output of
//
//   apt-get install -y --print-uris PACKAGE...
//
// on stdin: one line per package apt would fetch, dependencies included,
//   'URL' NAME_VERSION_ARCH.deb SIZE SHA256:...
// and prints "::tc:: total N" (server.mjs shows "N of M" from it), or
// "::tc:: refused REASON SENTENCE" and exits 4 when the set is over a limit:
//
//   TC_SET_MAX_PACKAGES   packages (default 400)
//   TC_SET_MAX_DEB_MB     their .debs together, MB (default 200)
//   TC_SET_REFUSE         a regular expression of package names never built on
//                         request (server.mjs PACKAGE_REFUSED: kernels, boot
//                         loaders, init, device managers, ...). A set is
//                         refused when anything it installs matches.
//   TC_SET_MAIN_ONLY=0    allow packages outside the archive's main component
//
// Every URL must be under pool/main/ (pool/updates/main/ for security
// updates): the set comes from Debian's main archive and from nowhere else.
// The caller points apt at an empty archive directory, so packages already
// downloaded for another set are listed too.
import { fileURLToPath } from 'node:url';

/** { ok: true, total, bytes } | { ok: false, reason, message } */
export function checkSet(text, { maxPackages = 400, maxDebMb = 200, refuse = '', mainOnly = true } = {}) {
  const packages = [];
  for (const line of text.split('\n')) {
    const m = /^'([^']+)' (\S+) (\d+) /.exec(line);
    if (!m) continue;
    packages.push({ url: m[1], name: decodeURIComponent(m[2]).split('_')[0], bytes: Number(m[3]) });
  }
  const bytes = packages.reduce((n, p) => n + p.bytes, 0);
  if (mainOnly) {
    const other = packages.filter((p) => !/\/pool\/(?:updates\/)?main\//.test(p.url));
    if (other.length) return { ok: false, reason: 'not-allowed', message: `${other.slice(0, 3).map((p) => p.name).join(', ')} ${other.length > 1 ? 'are' : 'is'} not in Debian's main archive.` };
  }
  if (refuse) {
    const re = new RegExp(refuse);
    const bad = packages.filter((p) => re.test(p.name));
    if (bad.length) return { ok: false, reason: 'not-allowed', message: `This set installs ${bad.slice(0, 3).map((p) => p.name).join(', ')}, which ${bad.length > 1 ? 'are' : 'is'} not built on this server.` };
  }
  if (packages.length > maxPackages) return { ok: false, reason: 'too-large', message: `This set installs ${packages.length} packages; the builder takes at most ${maxPackages}.` };
  if (bytes > maxDebMb * 1e6) return { ok: false, reason: 'too-large', message: `This set downloads ${Math.round(bytes / 1e6)} MB of packages; the builder takes at most ${maxDebMb} MB.` };
  return { ok: true, total: packages.length, bytes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const d of process.stdin) text += d;
  const num = (v, d) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
  const r = checkSet(text, {
    maxPackages: num(process.env.TC_SET_MAX_PACKAGES, 400), maxDebMb: num(process.env.TC_SET_MAX_DEB_MB, 200),
    refuse: process.env.TC_SET_REFUSE || '', mainOnly: process.env.TC_SET_MAIN_ONLY !== '0',
  });
  if (!r.ok) { console.log(`::tc:: refused ${r.reason} ${r.message}`); process.exit(4); }
  console.log(`::tc:: total ${r.total}`);
}
