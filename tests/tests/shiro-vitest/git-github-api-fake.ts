/**
 * An in-memory GitHub for git-github-api.test.ts: the REST endpoints
 * src/commands/git-github-api.ts uses, and raw.githubusercontent.com, as a
 * `fetch`. Objects are kept as git stores them, under the sha1 computed here
 * with node's crypto (not with the module's own hash), so an object the
 * module builds wrongly doesn't get the sha it expects.
 *
 * What it copies from the real API (checked against api.github.com): commit
 * dates come back in UTC without the commit's offset, a message without its
 * last newline, a signed commit with `verification.payload` (the commit
 * without its gpgsig header) and `signature`; an empty repository answers 409
 * on the git data API; a ref update that is not a fast-forward answers 422.
 */
import { createHash } from 'node:crypto';

type Kind = 'blob' | 'tree' | 'commit';
interface Obj { type: Kind; bytes: Uint8Array }
interface Entry { mode: string; path: string; sha: string }

const enc = new TextEncoder(), dec = new TextDecoder();

export function sha1(type: string, bytes: Uint8Array): string {
  return createHash('sha1').update(enc.encode(`${type} ${bytes.length}\0`)).update(bytes).digest('hex');
}

export function parseTree(bytes: Uint8Array): Entry[] {
  const out: Entry[] = [];
  for (let i = 0; i < bytes.length;) {
    const sp = bytes.indexOf(32, i), nul = bytes.indexOf(0, sp);
    out.push({
      mode: dec.decode(bytes.subarray(i, sp)), path: dec.decode(bytes.subarray(sp + 1, nul)),
      sha: Array.from(bytes.subarray(nul + 1, nul + 21), b => b.toString(16).padStart(2, '0')).join(''),
    });
    i = nul + 21;
  }
  return out;
}

function buildTree(entries: Entry[]): Uint8Array {
  const key = (e: Entry) => Buffer.from(e.path + (e.mode === '40000' ? '/' : ''));
  const parts: Buffer[] = [];
  for (const e of [...entries].sort((a, b) => Buffer.compare(key(a), key(b)))) {
    parts.push(Buffer.from(`${e.mode} ${e.path}\0`), Buffer.from(e.sha, 'hex'));
  }
  return new Uint8Array(Buffer.concat(parts));
}

export function parseCommit(bytes: Uint8Array) {
  const text = dec.decode(bytes);
  const cut = text.indexOf('\n\n');
  const lines = text.slice(0, cut).split('\n');
  const one = (k: string) => lines.find(l => l.startsWith(k + ' '))?.slice(k.length + 1) ?? '';
  const ident = (k: string) => {
    const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(one(k))!;
    return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString().replace('.000Z', 'Z') };
  };
  // The gpgsig header and its continuation lines
  const at = lines.findIndex(l => l.startsWith('gpgsig '));
  let end = at;
  while (at >= 0 && lines[end + 1]?.startsWith(' ')) end++;
  const signature = at < 0 ? null : [lines[at].slice(7), ...lines.slice(at + 1, end + 1).map(l => l.slice(1))].join('\n') + '\n';
  const unsigned = at < 0 ? null : [...lines.slice(0, at), ...lines.slice(end + 1)].join('\n') + text.slice(cut);
  return {
    tree: one('tree'), parents: lines.filter(l => l.startsWith('parent ')).map(l => l.slice(7)),
    author: ident('author'), committer: ident('committer'),
    message: text.slice(cut + 2).replace(/\n$/, ''),
    verification: { verified: false, reason: at < 0 ? 'unsigned' : 'unknown_key', signature, payload: unsigned },
  };
}

export interface FakeGitHub {
  fetch: typeof fetch;
  objects: Map<string, Obj>;
  /** Branches: name → commit sha */
  refs: Map<string, string>;
  /** Every request, as 'METHOD path' (the raw host: 'RAW path') */
  calls: string[];
  defaultBranch: string;
  /** A private repository is a 404 without a token */
  private: boolean;
  /** A recursive tree listing longer than this is cut and marked truncated */
  treeLimit: number;
  /** Requests answered before the primary rate limit sets in */
  quota: number;
  /** Store pushed commits with their dates in UTC, as a server that normalises would: another sha */
  normalizeDates: boolean;
  /** Called before each request is answered; may change the repository */
  hook?: (call: string) => void;
  put(type: Kind, bytes: Uint8Array): string;
  count(re: RegExp): number;
}

export function fakeGitHub(owner = 'ann', repo = 'proj'): FakeGitHub {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const fail = (status: number, message: string) => json(status, { message });
  const gh: FakeGitHub = {
    objects: new Map(), refs: new Map(), calls: [], defaultBranch: 'main', private: false,
    treeLimit: Infinity, quota: Infinity, normalizeDates: false,
    put(type, bytes) {
      const sha = sha1(type, bytes);
      gh.objects.set(sha, { type, bytes });
      return sha;
    },
    count: (re) => gh.calls.filter(c => re.test(c)).length,
    fetch: (async (input: any, init: any = {}) => {
      if (init.signal?.aborted) throw init.signal.reason;
      const url = new URL(String(input));
      const method = init.method ?? 'GET';
      const call = `${url.host === 'api.github.com' ? method : 'RAW'} ${url.pathname}${url.search}`;
      gh.hook?.(call);
      gh.calls.push(call);
      const headers = new Headers(init.headers);
      const signedIn = !!headers.get('authorization');
      if (url.host === 'raw.githubusercontent.com') return raw(url.pathname);
      if (headers.get('authorization') === 'Bearer bad') return fail(401, 'Bad credentials');
      if (--gh.quota < 0) {
        return json(403, { message: 'API rate limit exceeded for 203.0.113.7.' },
          { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800) });
      }
      const prefix = `/repos/${owner}/${repo}`;
      if (!url.pathname.startsWith(prefix) || (gh.private && !signedIn)) return fail(404, 'Not Found');
      if (method !== 'GET' && !signedIn) return fail(401, 'Requires authentication');
      const path = url.pathname.slice(prefix.length), q = url.searchParams;
      const body = init.body ? JSON.parse(init.body) : {};
      return route(method, path, q, body, headers);
    }) as typeof fetch,
  };

  const commitOf = (sha: string) => {
    const o = gh.objects.get(sha);
    return o?.type === 'commit' ? parseCommit(o.bytes) : null;
  };
  const treeOf = (sha: string): Entry[] | null => {
    const o = gh.objects.get(commitOf(sha)?.tree ?? sha);
    return o?.type === 'tree' ? parseTree(o.bytes) : null;
  };
  const kind = (mode: string) => mode === '40000' ? 'tree' : mode === '160000' ? 'commit' : 'blob';
  const listing = (sha: string, recursive: boolean, prefix = ''): any[] => (treeOf(sha) ?? []).flatMap(e => [
    {
      path: prefix + e.path, mode: e.mode.padStart(6, '0'), type: kind(e.mode), sha: e.sha,
      ...(kind(e.mode) === 'blob' ? { size: gh.objects.get(e.sha)!.bytes.length } : {}),
    },
    ...(recursive && e.mode === '40000' ? listing(e.sha, true, `${prefix}${e.path}/`) : []),
  ]);
  const isAncestor = (old: string, tip: string) => {
    const seen = new Set<string>();
    for (const stack = [tip]; stack.length;) {
      const sha = stack.pop()!;
      if (sha === old) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      stack.push(...(commitOf(sha)?.parents ?? []));
    }
    return false;
  };
  const commitJson = (sha: string) => {
    const c = commitOf(sha)!;
    return { author: c.author, committer: c.committer, message: c.message, tree: { sha: c.tree }, verification: c.verification };
  };

  function raw(pathname: string): Response {
    const [, o, r, commit, ...rest] = pathname.split('/').map(decodeURIComponent);
    if (o !== owner || r !== repo || gh.private) return new Response('404: Not Found', { status: 404 });
    let entries = treeOf(commit), found: Entry | undefined;
    for (const name of rest) {
      found = entries?.find(e => e.path === name);
      entries = found?.mode === '40000' ? treeOf(found.sha) : null;
    }
    // The real host follows a symlink instead of returning its target's name
    if (!found || kind(found.mode) !== 'blob' || found.mode === '120000') return new Response('404: Not Found', { status: 404 });
    return new Response(gh.objects.get(found.sha)!.bytes);
  }

  function route(method: string, path: string, q: URLSearchParams, body: any, headers: Headers): Response {
    const empty = gh.refs.size === 0;
    let m: RegExpExecArray | null;
    if (method === 'GET' && path === '') return json(200, { default_branch: gh.defaultBranch, private: gh.private });
    if (method === 'PUT' && (m = /^\/contents\/(.+)$/.exec(path))) {
      if (!empty) return fail(422, 'Invalid request: "sha" wasn\'t supplied.');
      const blob = gh.put('blob', new Uint8Array(Buffer.from(body.content, 'base64')));
      const tree = gh.put('tree', buildTree([{ mode: '100644', path: m[1], sha: blob }]));
      const sha = gh.put('commit', enc.encode(`tree ${tree}\nauthor Web <web@x.org> 1700000000 +0000\ncommitter GitHub <noreply@github.com> 1700000000 +0000\n\n${body.message}`));
      gh.refs.set(body.branch || gh.defaultBranch, sha);
      return json(201, { commit: { sha } });
    }
    if (empty && path.startsWith('/git/')) return fail(409, 'Git Repository is empty.');
    if (empty && path.startsWith('/commits')) return fail(409, 'Git Repository is empty.');

    if (method === 'GET' && (m = /^\/git\/ref\/heads\/(.+)$/.exec(path))) {
      const name = decodeURIComponent(m[1]);
      const sha = gh.refs.get(name);
      return sha ? json(200, { ref: `refs/heads/${name}`, object: { type: 'commit', sha } }) : fail(404, 'Not Found');
    }
    if (method === 'GET' && path === '/branches') {
      const per = Number(q.get('per_page') ?? 30), page = Number(q.get('page') ?? 1);
      return json(200, [...gh.refs].slice((page - 1) * per, page * per).map(([name, sha]) => ({ name, commit: { sha } })));
    }
    if (method === 'GET' && path === '/commits') {
      const start = gh.refs.get(q.get('sha') ?? gh.defaultBranch) ?? q.get('sha')!;
      if (!commitOf(start)) return fail(404, 'Not Found');
      const out: any[] = [], seen = new Set<string>();
      for (const queue = [start]; queue.length && out.length < Number(q.get('per_page') ?? 30);) {
        const sha = queue.shift()!;
        if (seen.has(sha) || !commitOf(sha)) continue;
        seen.add(sha);
        const parents = commitOf(sha)!.parents;
        out.push({ sha, commit: commitJson(sha), parents: parents.map(p => ({ sha: p })) });
        queue.push(...parents);
      }
      return json(200, out);
    }
    if (method === 'GET' && (m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(path))) {
      if (!commitOf(m[1])) return fail(404, 'Not Found');
      return json(200, { sha: m[1], ...commitJson(m[1]), parents: commitOf(m[1])!.parents.map(p => ({ sha: p })) });
    }
    if (method === 'GET' && (m = /^\/git\/trees\/([0-9a-f]{40})$/.exec(path))) {
      if (!treeOf(m[1])) return fail(404, 'Not Found');
      const recursive = q.has('recursive');
      const all = listing(m[1], recursive);
      const truncated = recursive && all.length > gh.treeLimit;
      return json(200, { sha: commitOf(m[1])?.tree ?? m[1], tree: truncated ? all.slice(0, gh.treeLimit) : all, truncated });
    }
    if (method === 'GET' && (m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(path))) {
      const o = gh.objects.get(m[1]);
      if (o?.type !== 'blob') return fail(404, 'Not Found');
      if (/vnd\.github\.raw/.test(headers.get('accept') ?? '')) return new Response(o.bytes);
      // GitHub breaks its base64 into lines
      return json(200, { sha: m[1], encoding: 'base64', content: Buffer.from(o.bytes).toString('base64').replace(/(.{60})/g, '$1\n'), size: o.bytes.length });
    }

    if (method === 'POST' && path === '/git/blobs') {
      return json(201, { sha: gh.put('blob', new Uint8Array(Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8'))) });
    }
    if (method === 'POST' && path === '/git/trees') {
      const entries: Entry[] = [];
      for (const e of body.tree) {
        if (e.type !== 'commit' && gh.objects.get(e.sha)?.type !== e.type) return fail(422, `tree.sha ${e.sha} is not a valid ${e.type}`);
        entries.push({ mode: String(e.mode).replace(/^0+/, ''), path: e.path, sha: e.sha });
      }
      return json(201, { sha: gh.put('tree', buildTree(entries)) });
    }
    if (method === 'POST' && path === '/git/commits') {
      if (gh.objects.get(body.tree)?.type !== 'tree') return fail(422, 'Tree SHA does not exist');
      for (const p of body.parents ?? []) if (!commitOf(p)) return fail(422, 'Parent SHA does not exist or is not a commit object');
      const line = (id: any) => {
        const t = /([+-])(\d\d):(\d\d)$/.exec(id.date);
        const tz = t && !gh.normalizeDates ? `${t[1]}${t[2]}${t[3]}` : '+0000';
        return `${id.name} <${id.email}> ${Math.floor(Date.parse(id.date) / 1000)} ${tz}`;
      };
      const text = `tree ${body.tree}\n` + (body.parents ?? []).map((p: string) => `parent ${p}\n`).join('')
        + `author ${line(body.author)}\ncommitter ${line(body.committer)}\n`
        + (body.signature ? `gpgsig ${String(body.signature).replace(/\n/g, '\n ')}\n` : '')
        + `\n${body.message}`;
      return json(201, { sha: gh.put('commit', enc.encode(text)) });
    }
    if (method === 'PATCH' && (m = /^\/git\/refs\/heads\/(.+)$/.exec(path))) {
      const name = decodeURIComponent(m[1]), old = gh.refs.get(name);
      if (!old) return fail(422, 'Reference does not exist');
      if (!commitOf(body.sha)) return fail(422, 'Object does not exist');
      if (!body.force && !isAncestor(old, body.sha)) return fail(422, 'Update is not a fast forward');
      gh.refs.set(name, body.sha);
      return json(200, { ref: `refs/heads/${name}`, object: { sha: body.sha } });
    }
    if (method === 'POST' && path === '/git/refs') {
      const name = String(body.ref).replace(/^refs\/heads\//, '');
      if (gh.refs.has(name)) return fail(422, 'Reference already exists');
      if (!commitOf(body.sha)) return fail(422, 'Object does not exist');
      gh.refs.set(name, body.sha);
      return json(201, { ref: body.ref, object: { sha: body.sha } });
    }
    return fail(404, `Not Found (the fake has no ${method} ${path})`);
  }

  return gh;
}
