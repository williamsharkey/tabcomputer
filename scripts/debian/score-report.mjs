// docs/DEBIAN_SCORE.md back into score.mjs's results (its --seed-from-report)

/**
 * --seed-from-report: a fresh clone has no results.json, and a run would write
 * a report without the ranks scored elsewhere. Rebuild the cache from the
 * committed report's scored and skipped rows; cached entries win (a real run
 * re-checks skips against the archive).
 */
export function parseReport(text) {
  const rows = {};
  for (const line of text.split('\n')) {
    if (!/^\| \d+ \|/.test(line)) continue;
    const cells = line.slice(2, -2).split(/ (?<!\\)\| /).map((c) => c.replace(/\\\|/g, '|'));
    const [rank, name, version, res, how, install] = cells;
    const m = /^(?:\*\*)?(\w+)(?:\*\*)?(?: \(([\w-]+)\))?$/.exec(res);
    if (!m || !(m[1] === 'skip' || (version && ['pass', 'fail'].includes(m[1])))) continue;
    const r = { name, rank: +rank, ...(version && { version }), result: m[1], seeded: true };
    if (m[1] === 'pass') r.smoke = how; else Object.assign(r, { category: m[2], error: how });
    const ms = /^(\d+) s( \(base\))?$/.exec(install ?? '');
    if (ms) Object.assign(r, { installMs: +ms[1] * 1000, already: !!ms[2] });
    rows[name] = r;
  }
  // "## Engines": "- NOTE: ranks 1, 2" (score.mjs --engine)
  const section = /^## Engines\n([\s\S]*?)(?=^## )/m.exec(text)?.[1] ?? '';
  for (const m of section.matchAll(/^- (.+): ranks ([\d, ]+)$/gm)) {
    const ranks = new Set(m[2].split(', ').map(Number));
    for (const r of Object.values(rows)) if (ranks.has(r.rank)) r.engine = m[1];
  }
  return rows;
}
