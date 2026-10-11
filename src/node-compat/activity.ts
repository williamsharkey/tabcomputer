/**
 * In-flight async work started by a node script (fetch, fs.promises), so a
 * script whose synchronous part has returned can exit as soon as it goes quiet
 * instead of waiting out the full deferred-exit timeout.
 *
 * One tracker per script: a page-wide count let a parent script waiting on its
 * child (pnpm run → node app.js) keep the child from ever looking idle, and
 * each waited on the other until the deferred-exit cap. Overlapping scripts
 * still share the page's fetch, which errs toward waiting longer.
 */
export interface ActivityTracker {
  activity: { pending: number; last: number };
  trackAsync<T>(p: Promise<T>): Promise<T>;
  /**
   * A fetch Response whose body reads count too: fetch() settles with the
   * headers, and a big body's chunks then arrive with nothing pending, so the
   * script looked idle mid-download and exited 0 (#50). Each read in flight
   * (reader.read(), for await, arrayBuffer/text/json/blob/bytes/formData,
   * pipeTo) is activity; a body nobody reads keeps nothing alive, as in node.
   */
  trackResponse(res: Response): Response;
  /** Wrap every promise-returning function on a module object (fs.promises and friends). */
  trackModule<T extends Record<string, any>>(mod: T): T;
}

export function createActivity(): ActivityTracker {
  const activity = { pending: 0, last: 0 };
  const marker = Symbol('shiroTracked');
  const trackAsync = <T>(p: Promise<T>): Promise<T> => {
    activity.pending++;
    activity.last = performance.now();
    const done = () => { activity.pending--; activity.last = performance.now(); };
    p.then(done, done);
    return p;
  };
  const trackModule = <T extends Record<string, any>>(mod: T): T => {
    if (!mod || (mod as any)[marker]) return mod;
    const out: any = {};
    for (const [key, value] of Object.entries(mod)) {
      out[key] = typeof value === 'function'
        ? function (this: any, ...args: any[]) {
            const r = value.apply(this, args);
            return r && typeof r.then === 'function' ? trackAsync(r) : r;
          }
        : value;
    }
    Object.defineProperty(out, marker, { value: true });
    return out;
  };
  const trackStream = (stream: ReadableStream<any> | null | undefined): void => {
    if (!stream || (stream as any)[marker]) return;
    Object.defineProperty(stream, marker, { value: true });
    const s = stream as any;
    const trackReader = (reader: any) => {
      if (reader && typeof reader.read === 'function') {
        const read = reader.read.bind(reader);
        reader.read = (...a: any[]) => trackAsync(read(...a));
      }
      return reader;
    };
    const trackIterator = (it: any) => {
      if (it && typeof it.next === 'function') {
        const next = it.next.bind(it);
        it.next = (...a: any[]) => trackAsync(next(...a));
      }
      return it;
    };
    const getReader = s.getReader?.bind(s);
    if (getReader) s.getReader = (...a: any[]) => trackReader(getReader(...a));
    for (const key of [Symbol.asyncIterator, 'values'] as const) {
      const f = s[key]?.bind(s);
      if (f) s[key] = (...a: any[]) => trackIterator(f(...a));
    }
    const pipeTo = s.pipeTo?.bind(s);
    if (pipeTo) s.pipeTo = (...a: any[]) => trackAsync(pipeTo(...a));
    const pipeThrough = s.pipeThrough?.bind(s);
    if (pipeThrough) s.pipeThrough = (...a: any[]) => { const out = pipeThrough(...a); trackStream(out); return out; };
    const tee = s.tee?.bind(s);
    if (tee) s.tee = () => { const pair = tee(); pair.forEach(trackStream); return pair; };
  };
  const trackResponse = (res: Response): Response => {
    if (!res || (res as any)[marker]) return res;
    Object.defineProperty(res, marker, { value: true });
    const r = res as any;
    for (const m of ['arrayBuffer', 'text', 'json', 'blob', 'bytes', 'formData']) {
      const f = r[m]?.bind(r);
      if (f) r[m] = (...a: any[]) => trackAsync(f(...a));
    }
    const clone = r.clone?.bind(r);
    if (clone) r.clone = () => trackResponse(clone());
    try { trackStream(res.body); } catch { /* no body */ }
    return res;
  };
  return { activity, trackAsync, trackModule, trackResponse };
}
