/**
 * git tag: list (-l patterns, -n[N], --sort, --contains, --points-at), create
 * (lightweight, or annotated with -a/-m/-F; -f to move one), delete (-d).
 * The tagger is the committer git would use (GIT_COMMITTER_*, user.name).
 */
import git from './git-cached';
import { CommandContext } from './index';
import { resolveSpec } from './git-plumbing';

export interface TagIdent { name: string; email: string; timestamp?: number; timezoneOffset?: number }

/** git's version sort (v:refname): digit runs compare as numbers */
function versionCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const pa = a.match(re) ?? [], pb = b.match(re) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (/^\d/.test(x) && /^\d/.test(y)) { const d = Number(x) - Number(y); if (d) return d; }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return pa.length - pb.length;
}

export async function gitTagHandler(ctx: CommandContext, fs: any, dir: string, ident: () => Promise<TagIdent>): Promise<number> {
  let del = false, list = false, annotated = false, force = false, lines = 0;
  let message: string | null = null, sort = '', contains: string | null = null, pointsAt: string | null = null;
  const positional: string[] = [];
  const args = ctx.args;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '-d' || a === '--delete') del = true;
    else if (a === '-a' || a === '--annotate') annotated = true;
    else if (a === '-f' || a === '--force') force = true;
    else if (a === '-l' || a === '--list') list = true;
    else if (a === '-m' || a === '--message') { message = (message ? message + '\n\n' : '') + (args[++i] ?? ''); annotated = true; }
    else if (a.startsWith('--message=')) { message = a.slice(10); annotated = true; }
    else if (a.startsWith('-m') && a.length > 2) { message = a.slice(2); annotated = true; }
    else if (a === '-F' || a === '--file') { const f = args[++i] ?? ''; message = f === '-' ? ctx.stdin : await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') as string; annotated = true; }
    else if (/^-n\d*$/.test(a)) { lines = a.length > 2 ? Number(a.slice(2)) : 1; list = true; }
    else if (a.startsWith('--sort=')) sort = a.slice(7);
    else if (a === '--contains') { contains = args[i + 1] && !args[i + 1].startsWith('-') ? args[++i] : 'HEAD'; list = true; }
    else if (a.startsWith('--contains=')) { contains = a.slice(11); list = true; }
    else if (a === '--points-at') { pointsAt = args[i + 1] && !args[i + 1].startsWith('-') ? args[++i] : 'HEAD'; list = true; }
    else if (a.startsWith('--points-at=')) { pointsAt = a.slice(12); list = true; }
    else if (!a.startsWith('-')) positional.push(a);
  }

  if (del) {
    if (!positional.length) { ctx.stderr = 'fatal: tag name required\n'; return 128; }
    const tags = await git.listTags({ fs, dir });
    let status = 0;
    for (const name of positional) {
      if (!tags.includes(name)) { ctx.stderr += `error: tag '${name}' not found.\n`; status = 1; continue; }
      const oid = await git.resolveRef({ fs, dir, ref: `refs/tags/${name}` });
      await git.deleteTag({ fs, dir, ref: name });
      ctx.stdout += `Deleted tag '${name}' (was ${oid.slice(0, 7)})\n`;
    }
    return status;
  }

  if (positional.length && !list) {
    const [name, ref = 'HEAD'] = positional;
    if (!(await git.listTags({ fs, dir })).includes(name) || force) {
      let oid: string;
      try { oid = await resolveSpec(fs, dir, ref); }
      catch { ctx.stderr = `fatal: Failed to resolve '${ref}' as a valid ref.\n`; return 128; }
      if (annotated) {
        if (message === null) { ctx.stderr = 'fatal: no tag message given (use -m or -F)\n'; return 128; }
        const who = await ident();
        const type = (await git.readObject({ fs, dir, oid, format: 'content' })).type;
        const tagOid = await git.writeTag({
          fs, dir, tag: {
            object: oid, type: type as 'commit', tag: name,
            tagger: { name: who.name, email: who.email, timestamp: who.timestamp ?? Math.floor(Date.now() / 1000), timezoneOffset: who.timezoneOffset ?? new Date().getTimezoneOffset() },
            message: message.replace(/\n*$/, ''), // (isomorphic-git adds the newline)
          },
        });
        await git.writeRef({ fs, dir, ref: `refs/tags/${name}`, value: tagOid, force: true });
      } else {
        await git.writeRef({ fs, dir, ref: `refs/tags/${name}`, value: oid, force: true });
      }
      return 0;
    }
    ctx.stderr = `fatal: tag '${name}' already exists\n`;
    return 128;
  }

  // list: by name (or --sort), the patterns given, each with -n's message lines
  let tags = await git.listTags({ fs, dir });
  if (positional.length) {
    const res = positional.map((p) => new RegExp('^' + p.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'));
    tags = tags.filter((t) => res.some((re) => re.test(t)));
  }
  const peeled = async (t: string) => {
    let oid = await git.resolveRef({ fs, dir, ref: `refs/tags/${t}` });
    for (let i = 0; i < 10; i++) {
      const o = await git.readObject({ fs, dir, oid }).catch(() => null);
      if (o?.type !== 'tag') break;
      oid = (o.object as any).object;
    }
    return oid;
  };
  if (pointsAt) {
    const want = await resolveSpec(fs, dir, pointsAt).catch(() => null);
    const keep: string[] = [];
    for (const t of tags) if (await peeled(t) === want || await git.resolveRef({ fs, dir, ref: `refs/tags/${t}` }) === want) keep.push(t);
    tags = keep;
  }
  if (contains) {
    let want: string;
    try { want = await resolveSpec(fs, dir, contains); } catch { ctx.stderr = `error: malformed object name ${contains}\n`; return 129; }
    const keep: string[] = [];
    for (const t of tags) {
      const c = await peeled(t);
      if (c === want || await git.isDescendent({ fs, dir, oid: c, ancestor: want, depth: -1 }).catch(() => false)) keep.push(t);
    }
    tags = keep;
  }
  const desc = sort.startsWith('-');
  const key = sort.replace(/^-/, '');
  tags.sort(key === 'v:refname' || key === 'version:refname' ? versionCompare : (a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (desc) tags.reverse();
  for (const t of tags) {
    if (!lines) { ctx.stdout += t + '\n'; continue; }
    // -n: the tag's message, or the commit's for a lightweight tag
    const oid = await git.resolveRef({ fs, dir, ref: `refs/tags/${t}` });
    const o = await git.readObject({ fs, dir, oid }).catch(() => null);
    let msg = '';
    if (o?.type === 'tag') msg = (o.object as any).message ?? '';
    else if (o?.type === 'commit') msg = (o.object as any).message ?? '';
    const body = msg.replace(/\n+$/, '').split('\n').slice(0, lines);
    ctx.stdout += `${t.padEnd(15)} ${body.join('\n    ')}\n`;
  }
  return 0;
}
