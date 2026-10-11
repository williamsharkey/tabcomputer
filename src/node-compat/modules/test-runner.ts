/**
 * node:test: test/it, describe/suite, hooks, skip/todo/only, subtests (t.test) and
 * mock.fn/mock.method, reported as node 22 does: spec on a terminal, TAP otherwise
 * (--test-reporter picks). `node --test` (node-run.ts) runs each file as a child node
 * whose events come back as lines on its stdout (NODE_TEST_CONTEXT=child-json), and
 * reports them together with one summary.
 */

export interface TestDeps {
  getProcess: () => any;
  /** Counts a promise as the script's activity (the run keeps the script alive) */
  trackAsync?: <T>(p: Promise<T>) => Promise<T>;
  /** util.inspect, for a failure's details */
  inspect: (v: unknown, opts?: any) => string;
  /** node:assert (t.assert) */
  assert?: () => any;
  /** node:child_process (node --test runs each file in one) */
  childProcess: () => any;
}

/** What a child node writes per event (the rest of its stdout is the tests' own output) */
const EVENT_MARK = '\u0000node-test\u0000';

type Kind = 'test' | 'suite';
interface TestEvent {
  type: 'start' | 'pass' | 'fail' | 'stdout' | 'plan';
  name?: string;
  nesting: number;
  kind?: Kind;
  duration?: number;
  skip?: string | true;
  todo?: string | true;
  error?: { text: string; yaml: string[] };
  file?: string;
  /** (plan) how many children a test had */
  count?: number;
  /** (stdout) a line the tests printed */
  line?: string;
}

// ── reporters ────────────────────────────────────────────────────────────────

interface Totals { tests: number; suites: number; pass: number; fail: number; cancelled: number; skipped: number; todo: number }
const emptyTotals = (): Totals => ({ tests: 0, suites: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 });

function count(t: Totals, e: TestEvent): void {
  if (e.type !== 'pass' && e.type !== 'fail') return;
  if (e.kind === 'suite') { t.suites++; return; }
  t.tests++;
  if (e.type === 'fail') t.fail++;
  else if (e.skip) t.skipped++;
  else if (e.todo) t.todo++;
  else t.pass++;
}

const ms = (d: number) => `${Math.round(d * 1e6) / 1e6}ms`;

/** A node option's value from execArgv (`--opt=v` or `--opt v`) */
function execOption(execArgv: string[] | undefined, name: string): string | undefined {
  if (!execArgv) return undefined;
  for (let i = 0; i < execArgv.length; i++) {
    if (execArgv[i] === name) return execArgv[i + 1];
    if (execArgv[i].startsWith(name + '=')) return execArgv[i].slice(name.length + 1);
  }
  return undefined;
}

/** Where this runtime's own code is (its stack frames are left out of a failure's, as node leaves out its internals) */
const RUNTIME_URL = (() => {
  const frame = String(new Error().stack ?? '').split('\n').find((l) => /^\s+at /.test(l)) ?? '';
  return /\(?([^\s()]+?):\d+:\d+\)?$/.exec(frame)?.[1];
})();
/** Whether a stack line is one of this runtime's frames (a user's, run by eval, ends in <anonymous>:L:C) */
const runtimeFrame = (line: string) => !!RUNTIME_URL && /^\s+at /.test(line) && /\(?([^\s()]+?):\d+:\d+\)?(?: \{)?$/.exec(line)?.[1] === RUNTIME_URL;
/** Inspected text without this runtime's frames (the last one's ` {`, before the error's properties, kept) */
function withoutRuntimeFrames(text: string): string {
  const out: string[] = [];
  for (const l of text.split('\n')) {
    if (!runtimeFrame(l)) { out.push(l); continue; }
    if (l.endsWith(' {') && out.length) out[out.length - 1] += ' {';
  }
  return out.join('\n');
}

/** node's spec reporter: ✔/✖ per test, ▶ before a test's children, failures again at the end */
function specReporter(write: (s: string) => void, color: boolean) {
  const c = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[39m` : s);
  const failures: { e: TestEvent; nesting: number }[] = [];
  /** per nesting level: the started test whose ▶ line isn't out yet */
  const pending: { name: string; nesting: number; shown: boolean }[] = [];
  const pad = (n: number) => '  '.repeat(n);
  const showParents = () => {
    for (const p of pending) if (!p.shown) { write(`${pad(p.nesting)}${c('39', '▶')} ${p.name}\n`); p.shown = true; }
  };
  const line = (e: TestEvent) => {
    const dir = e.skip ? ` # SKIP${typeof e.skip === 'string' ? ` ${e.skip}` : ''}` : e.todo ? ` # TODO${typeof e.todo === 'string' ? ` ${e.todo}` : ''}` : '';
    if (e.type === 'fail') return `${c('31', '✖')} ${e.name} (${ms(e.duration ?? 0)})${dir}`;
    if (e.skip) return `${c('90', '﹣')} ${e.name} (${ms(e.duration ?? 0)})${dir}`;
    return `${c('32', '✔')} ${e.name} (${ms(e.duration ?? 0)})${dir}`;
  };
  return {
    event(e: TestEvent) {
      if (e.type === 'start') { pending.push({ name: e.name!, nesting: e.nesting, shown: false }); return; }
      if (e.type === 'stdout') { write(e.line! + '\n'); return; }
      if (e.type === 'plan') return;
      const top = pending.pop();
      if (top && top.shown) { /* its ▶ is out: the result closes it */ }
      showParents();
      write(`${pad(e.nesting)}${line(e)}\n`);
      if (e.type === 'fail' && e.error && e.kind !== 'suite') failures.push({ e, nesting: e.nesting });
    },
    summary(t: Totals, duration: number) {
      const info = c('34', 'ℹ');
      write(`${info} tests ${t.tests}\n${info} suites ${t.suites}\n${info} pass ${t.pass}\n${info} fail ${t.fail}\n${info} cancelled ${t.cancelled}\n${info} skipped ${t.skipped}\n${info} todo ${t.todo}\n${info} duration_ms ${Math.round(duration * 1e6) / 1e6}\n`);
      if (!failures.length) return;
      write(`\n${c('31', '✖ failing tests:')}\n\n`);
      for (const { e } of failures) {
        write(`${e.file ? `test at ${e.file}\n` : ''}${line(e)}\n`);
        write(e.error!.text.split('\n').map((l) => (l ? '  ' + l : l)).join('\n') + '\n\n');
      }
    },
  };
}

/** node's TAP reporter (version 13, a YAML block per test, subtests indented 4) */
function tapReporter(write: (s: string) => void) {
  const numbers: number[] = [0];
  const pad = (n: number) => '    '.repeat(n);
  write('TAP version 13\n');
  return {
    event(e: TestEvent) {
      const p = pad(e.nesting);
      if (e.type === 'start') { write(`${p}# Subtest: ${e.name}\n`); numbers[e.nesting + 1] = 0; return; }
      if (e.type === 'stdout') { write(`# ${e.line}\n`); return; }
      if (e.type === 'plan') { if (e.count) write(`${pad(e.nesting + 1)}1..${e.count}\n`); return; }
      const n = (numbers[e.nesting] = (numbers[e.nesting] ?? 0) + 1);
      const dir = e.skip ? ` # SKIP${typeof e.skip === 'string' ? ` ${e.skip}` : ''}` : e.todo ? ` # TODO${typeof e.todo === 'string' ? ` ${e.todo}` : ''}` : '';
      write(`${p}${e.type === 'fail' ? 'not ok' : 'ok'} ${n} - ${e.name}${dir}\n`);
      write(`${p}  ---\n${p}  duration_ms: ${Math.round((e.duration ?? 0) * 1e6) / 1e6}\n${p}  type: '${e.kind ?? 'test'}'\n`);
      if (e.type === 'fail' && e.error) for (const l of e.error.yaml) write(`${p}  ${l}\n`);
      write(`${p}  ...\n`);
    },
    summary(t: Totals, duration: number, topCount: number) {
      write(`1..${topCount}\n# tests ${t.tests}\n# suites ${t.suites}\n# pass ${t.pass}\n# fail ${t.fail}\n# cancelled ${t.cancelled}\n# skipped ${t.skipped}\n# todo ${t.todo}\n# duration_ms ${Math.round(duration * 1e6) / 1e6}\n`);
    },
  };
}

type Reporter = ReturnType<typeof specReporter> & { summary(t: Totals, duration: number, topCount: number): void };

function makeReporter(name: string | undefined, write: (s: string) => void, tty: boolean): Reporter {
  const r = name ?? (tty ? 'spec' : 'tap');
  return (r === 'tap' ? tapReporter(write) : specReporter(write, tty)) as Reporter;
}

/** A failure's details: the inspected error for spec, YAML lines for TAP */
function describeError(err: any, inspect: TestDeps['inspect'], location: string | undefined, suite: boolean, failedSubtests: number): TestEvent['error'] {
  if (suite) {
    return {
      text: `'${failedSubtests} subtest${failedSubtests === 1 ? '' : 's'} failed'`,
      yaml: [...(location ? [`location: '${location}'`] : []), `failureType: 'subtestsFailed'`, `error: '${failedSubtests} subtest${failedSubtests === 1 ? '' : 's'} failed'`, `code: 'ERR_TEST_FAILURE'`],
    };
  }
  let text: string;
  try { text = err instanceof Error ? inspect(err) : `Error: ${inspect(err)}`; } catch { text = String(err); }
  text = withoutRuntimeFrames(text);
  const yaml = [...(location ? [`location: '${location}'`] : []), `failureType: 'testCodeFailure'`];
  const message = String(err?.message ?? err);
  yaml.push(message.includes('\n') ? `error: |-\n${message.split('\n').map((l) => '  ' + l).join('\n')}` : `error: '${message.replace(/'/g, "''")}'`);
  if (err && typeof err === 'object') {
    if (err.code !== undefined) yaml.push(`code: '${err.code}'`);
    if (err.name) yaml.push(`name: '${err.name}'`);
    if ('expected' in err) yaml.push(`expected: ${inspect(err.expected)}`);
    if ('actual' in err) yaml.push(`actual: ${inspect(err.actual)}`);
    if (err.operator) yaml.push(`operator: '${err.operator}'`);
    const frames = String(err.stack ?? '').split('\n').filter((l) => /^\s+at /.test(l) && !runtimeFrame(l)).map((l) => l.trim().replace(/^at /, ''));
    if (frames.length) yaml.push(`stack: |-\n${frames.map((f) => '  ' + f).join('\n')}`);
  }
  // (the YAML block's nested lines carry their own indent after the first)
  return { text, yaml: yaml.flatMap((y) => y.split('\n')) };
}

// ── the tests ────────────────────────────────────────────────────────────────

type Fn = (t: any, done?: (err?: unknown) => void) => unknown;
interface Hooks { before: Fn[]; after: Fn[]; beforeEach: Fn[]; afterEach: Fn[] }
interface Node {
  name: string;
  kind: Kind;
  fn?: Fn;
  skip?: string | true;
  todo?: string | true;
  children: Node[];
  parent?: Node;
  hooks: Hooks;
  nesting: number;
}

const newHooks = (): Hooks => ({ before: [], after: [], beforeEach: [], afterEach: [] });

export function createTestModule(deps: TestDeps): any {
  const proc = () => deps.getProcess();
  const write = (s: string) => proc()?.stdout?.write(s);
  const child = proc()?.env?.NODE_TEST_CONTEXT === 'child-json';
  const reporterName = execOption(proc()?.execArgv, '--test-reporter');
  const pattern = execOption(proc()?.execArgv, '--test-name-pattern');
  const namePattern: RegExp[] = pattern ? [new RegExp(pattern)] : [];
  const file = (() => { const a = proc()?.argv?.[1]; const cwd = proc()?.cwd?.() ?? ''; return a ? (a.startsWith(cwd + '/') ? a.slice(cwd.length + 1) : a) : undefined; })();

  const root: Node = { name: '<root>', kind: 'suite', children: [], hooks: newHooks(), nesting: -1 };
  /** The suite whose describe() callback is collecting, or the test whose fn is running */
  let current: Node = root;
  const totals = emptyTotals();
  let reporter: Reporter | null = null;
  const emit = (e: TestEvent) => {
    if (child) { write(EVENT_MARK + JSON.stringify(e) + '\n'); return; }
    reporter ??= makeReporter(reporterName, (s) => write(s), !!proc()?.stdout?.isTTY);
    count(totals, e);
    reporter.event(e);
  };

  // ── running ──
  const started = performance.now();
  let queue: Node[] = [];
  let running: Promise<void> | null = null;
  let ran = 0;
  let anyFailed = false;

  const callFn = (fn: Fn, t: any): Promise<unknown> => {
    if (fn.length >= 2) {
      return new Promise((resolve, reject) => {
        try { fn(t, (err?: unknown) => (err ? reject(err) : resolve(undefined))); } catch (e) { reject(e); }
      });
    }
    try { return Promise.resolve(fn(t)); } catch (e) { return Promise.reject(e); }
  };

  const hooksFor = (n: Node, kind: 'beforeEach' | 'afterEach'): Fn[] => {
    const chain: Fn[][] = [];
    for (let p = n.parent; p; p = p.parent) chain.unshift(p.hooks[kind]);
    return kind === 'beforeEach' ? chain.flat() : chain.reverse().flat();
  };

  const matches = (n: Node): boolean => {
    if (!namePattern.length || n.kind === 'suite') return true;
    const full: string[] = [];
    for (let p: Node | undefined = n; p && p !== root; p = p.parent) full.unshift(p.name);
    return namePattern.some((re) => re.test(n.name) || re.test(full.join(' ')));
  };

  /** Run one test or suite (its children after it), emitting its events; whether it passed */
  async function run(n: Node): Promise<boolean> {
    if (!matches(n)) return true;
    emit({ type: 'start', name: n.name, nesting: n.nesting, kind: n.kind, file });
    const t0 = performance.now();
    let error: unknown;
    let failedChildren = 0;
    let skip = n.skip, todo = n.todo;
    const ctxObj = makeContext(n, (m) => { skip = m ?? true; }, (m) => { todo = m ?? true; });
    if (!skip) {
      const outer = current;
      try {
        if (n.kind === 'suite') {
          for (const h of n.hooks.before) await callFn(h, ctxObj);
          for (const c of n.children) if (!(await run(c))) failedChildren++;
          for (const h of n.hooks.after) await callFn(h, ctxObj);
        } else {
          for (const h of hooksFor(n, 'beforeEach')) await callFn(h, ctxObj);
          current = n;
          try { if (n.fn) await callFn(n.fn, ctxObj); } finally { current = outer; }
          // subtests started with t.test and not awaited are waited for
          for (const p of ctxObj[SUBTESTS] as Promise<boolean>[]) if (!(await p)) failedChildren++;
          for (const h of hooksFor(n, 'afterEach')) await callFn(h, ctxObj);
        }
      } catch (e) { error = e; }
      current = outer;
    }
    const duration = performance.now() - t0;
    if (n.children.length || (ctxObj[SUBTESTS] as unknown[]).length) emit({ type: 'plan', nesting: n.nesting, count: n.children.length || (ctxObj[SUBTESTS] as unknown[]).length });
    // (a todo test's failure isn't one)
    const failed = !todo && (error !== undefined || failedChildren > 0);
    if (failed) {
      const suite = error === undefined;
      emit({ type: 'fail', name: n.name, nesting: n.nesting, kind: n.kind, duration, skip, todo, file, error: describeError(error, deps.inspect, file, suite, failedChildren) });
      anyFailed = true;
    } else {
      emit({ type: 'pass', name: n.name, nesting: n.nesting, kind: n.kind, duration, skip, todo, file });
    }
    return !failed;
  }

  const SUBTESTS = Symbol('subtests');
  function makeContext(n: Node, onSkip: (m?: string) => void, onTodo: (m?: string) => void): any {
    const subtests: Promise<boolean>[] = [];
    const t: any = {
      name: n.name,
      signal: new AbortController().signal,
      [SUBTESTS]: subtests,
      diagnostic: (msg: string) => emit({ type: 'stdout', nesting: n.nesting + 1, line: msg }),
      skip: (msg?: string) => onSkip(msg),
      todo: (msg?: string) => onTodo(msg),
      plan: () => {},
      mock: mockApi,
      test: (name: any, opts?: any, fn?: any) => {
        const sub = makeNode(name, opts, fn, 'test', n);
        const p = run(sub);
        subtests.push(p);
        return p.then(() => undefined);
      },
      before: (fn: Fn) => n.hooks.before.push(fn),
      after: (fn: Fn) => n.hooks.after.push(fn),
      beforeEach: (fn: Fn) => n.hooks.beforeEach.push(fn),
      afterEach: (fn: Fn) => n.hooks.afterEach.push(fn),
    };
    Object.defineProperty(t, 'assert', { get: () => deps.assert?.(), enumerable: true });
    return t;
  }

  function makeNode(name: any, opts: any, fn: any, kind: Kind, parent: Node): Node {
    if (typeof name === 'function') { fn = name; opts = undefined; name = fn.name || '<anonymous>'; }
    else if (typeof name === 'object' && name !== null) { fn = opts; opts = name; name = fn?.name || '<anonymous>'; }
    if (typeof opts === 'function') { fn = opts; opts = undefined; }
    const o = opts ?? {};
    return {
      name: String(name), kind, fn, parent, children: [], hooks: newHooks(), nesting: parent.nesting + 1,
      skip: o.skip ? (typeof o.skip === 'string' ? o.skip : true) : undefined,
      todo: o.todo ? (typeof o.todo === 'string' ? o.todo : true) : (kind === 'test' && !fn ? true : undefined),
    };
  }

  /** Root tests run in order, each once those before it are done; the summary once none are left */
  function schedule(): Promise<void> {
    if (running) return running;
    const loop = async () => {
      for (;;) {
        while (queue.length) {
          const n = queue.shift()!;
          await run(n);
          ran++;
        }
        // (tests registered later: after an await at the top of a module)
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        if (!queue.length) break;
      }
      finish();
    };
    running = loop();
    deps.trackAsync?.(running);
    return running;
  }

  function finish() {
    if (anyFailed) { const p = proc(); if (p && !p.exitCode) p.exitCode = 1; }
    if (child) return;
    reporter ??= makeReporter(reporterName, (s) => write(s), !!proc()?.stdout?.isTTY);
    reporter.summary(totals, performance.now() - started, ran);
  }

  /** test()/it() and describe(): a child of the suite collecting, else of the root (run in turn) */
  function register(kind: Kind, name: any, opts?: any, fn?: any): Promise<void> {
    const parent = current.kind === 'suite' ? current : root;
    const n = makeNode(name, opts, fn, kind, parent);
    if (kind === 'suite') {
      const outer = current;
      current = n;
      try { n.fn?.({ name: n.name }); } finally { current = outer; }
    }
    if (parent === root) { queue.push(n); return schedule(); }
    parent.children.push(n);
    return Promise.resolve();
  }

  const withVariants = (kind: Kind) => {
    const f: any = (name: any, opts?: any, fn?: any) => register(kind, name, opts, fn);
    const variant = (extra: object) => (name: any, opts?: any, fn?: any) => {
      if (typeof opts === 'function') { fn = opts; opts = {}; }
      return register(kind, name, { ...(opts ?? {}), ...extra }, fn);
    };
    f.skip = variant({ skip: true });
    f.todo = variant({ todo: true });
    f.only = variant({ only: true });
    return f;
  };

  // ── mock ──
  const restorers = new Set<() => void>();
  const mockFn = (original?: Function, impl?: Function): any => {
    let current = impl ?? original ?? (() => undefined);
    const once = new Map<number, Function>();
    const calls: any[] = [];
    const fn: any = function (this: any, ...args: any[]) {
      const call: any = { arguments: args, this: this, target: new.target };
      const which = once.get(calls.length) ?? current;
      once.delete(calls.length);
      calls.push(call);
      try {
        const result = new.target ? Reflect.construct(which as any, args, new.target) : which.apply(this, args);
        call.result = result;
        return result;
      } catch (e) { call.error = e; throw e; }
    };
    fn.mock = {
      calls,
      callCount: () => calls.length,
      resetCalls: () => { calls.length = 0; },
      mockImplementation: (f: Function) => { current = f; },
      mockImplementationOnce: (f: Function, onCall?: number) => { once.set(onCall ?? calls.length, f); },
      restore: () => { current = original ?? (() => undefined); },
    };
    return fn;
  };
  const mockApi: any = {
    fn: (original?: Function, impl?: Function) => mockFn(original, impl),
    method: (obj: any, name: string, impl?: Function) => {
      const original = obj[name];
      const m = mockFn(original, impl);
      obj[name] = m;
      const restore = () => { obj[name] = original; };
      m.mock.restore = restore;
      restorers.add(restore);
      return m;
    },
    reset: () => { for (const r of restorers) r(); restorers.clear(); },
    restoreAll: () => { for (const r of restorers) r(); restorers.clear(); },
  };

  const test = withVariants('test');
  const describe = withVariants('suite');
  const hook = (kind: keyof Hooks) => (fn: Fn) => { (current.kind === 'suite' ? current : root).hooks[kind].push(fn); };
  Object.assign(test, {
    test, it: test, describe, suite: describe,
    before: hook('before'), after: hook('after'), beforeEach: hook('beforeEach'), afterEach: hook('afterEach'),
    mock: mockApi,
    default: test,
    [Symbol.for('tabcomputer.runTestFiles')]: (files: string[], opts: RunOpts) => runTestFiles(files, opts, deps),
  });
  return test;
}

// ── node --test: each file a child node, reported together ──────────────────

interface RunOpts { reporter?: string; namePattern?: string; execPath: string }

async function runTestFiles(files: string[], opts: RunOpts, deps: TestDeps): Promise<void> {
  const proc = deps.getProcess();
  const write = (s: string) => proc.stdout.write(s);
  const reporter = makeReporter(opts.reporter, write, !!proc.stdout.isTTY);
  const totals = emptyTotals();
  const started = performance.now();
  let top = 0;
  let failed = false;
  const { spawn } = deps.childProcess();
  for (const file of files) {
    const env = { ...proc.env, NODE_TEST_CONTEXT: 'child-json' };
    const t0 = performance.now();
    let sawTop = 0;
    let stderr = '';
    const code: number = await new Promise((resolve) => {
      const c = spawn(opts.execPath, [...(opts.namePattern ? [`--test-name-pattern=${opts.namePattern}`] : []), file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      const onLine = (l: string) => {
        if (l.startsWith(EVENT_MARK)) {
          let e: TestEvent;
          try { e = JSON.parse(l.slice(EVENT_MARK.length)); } catch { return; }
          if ((e.type === 'pass' || e.type === 'fail') && e.nesting === 0) sawTop++;
          if (e.type === 'fail') failed = true;
          count(totals, e);
          reporter.event(e);
        } else if (l.length) reporter.event({ type: 'stdout', nesting: 0, line: l });
      };
      c.stdout.on('data', (d: any) => { buf += String(d); let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
      c.stderr.on('data', (d: any) => { stderr += String(d); });
      c.on('close', (code: number) => { if (buf) onLine(buf); resolve(code ?? 1); });
      c.on('error', () => resolve(1));
    });
    top += sawTop;
    // A file that failed without a failing test (it threw while loading, or exited non-zero): a failure of its own
    if (code !== 0 && !sawTop) {
      const err = Object.assign(new Error(`test failed`), { code: 'ERR_TEST_FAILURE' });
      const text = stderr.trim() ? `${stderr.trim()}` : `exit code ${code}`;
      const e: TestEvent = { type: 'fail', name: file, nesting: 0, kind: 'test', duration: performance.now() - t0, file, error: { text, yaml: [`location: '${file}'`, `failureType: 'testCodeFailure'`, `exitCode: ${code}`, `error: 'test failed'`, `code: '${err.code}'`] } };
      count(totals, e);
      reporter.event({ type: 'start', name: file, nesting: 0, kind: 'test' });
      reporter.event(e);
      failed = true;
      top++;
    } else if (stderr) proc.stderr.write(stderr);
  }
  reporter.summary(totals, performance.now() - started, top);
  if (failed) proc.exitCode = 1;
}
