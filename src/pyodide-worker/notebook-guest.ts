/**
 * A notebook's kernel, in a Pyodide guest (guest.ts starts it when the start
 * message has `notebook`). One Python stays up for the notebook's life: the
 * page (src/notebook/kernel.ts) sends cells and this runs them in one
 * namespace.
 *
 * It talks to the page over fd 3 of its process, a line of JSON each way.
 * Every call on it is a syscall, so a wait for the next cell, for `input()`
 * or for a `!command` blocks this Worker only, what a cell prints (fds 1 and
 * 2) and what it displays arrive in the order they were made, and it works
 * where the engine cannot switch stacks.
 *
 *   page → guest   {t:'exec', id, code, packages}   {t:'load', id, code, packages}
 *                  {t:'reply', rid, …}              {t:'shutdown'}
 *   guest → page   {t:'ready', python}   {t:'status', text}   {t:'done', id, status, count}
 *                  {t:'display'|'result'|'error'|'clear', …}  (nbformat.ts KernelOutput)
 *                  {t:'input', rid, prompt, password}   {t:'shell', rid, cmd, cwd, capture}
 */
import { NB_KERNEL_PY, NB_MPL_PY, NB_STUBS } from './notebook-py';

/** What the page puts in the start message */
export interface NotebookStart {
  /** site-packages directories of the tab's pip */
  sitePaths: string[];
}

export interface NotebookIo {
  /** Bytes from the page into `buf`: the count, 0 when the page closed it, or a negative Linux errno (-4: interrupted) */
  ctlRead(buf: Uint8Array): number;
  ctlWrite(data: Uint8Array): void;
  /** The cell's stdout (1) and stderr (2) */
  write(fd: 1 | 2, data: Uint8Array): void;
  /** Whether an interrupt was raised and Python has not taken it yet */
  interrupted(): boolean;
  /** Drop an interrupt that was raised and not taken */
  clearInterrupt(): void;
}

const EINTR = 4;

function installKernel(py: any): void {
  const v = String(py.runPython('import sys; "%d.%d" % sys.version_info[:2]'));
  const site = `/lib/python${v}/site-packages`;
  py.FS.mkdirTree(site);
  py.FS.writeFile(`${site}/tabcomputer_nb.py`, NB_KERNEL_PY);
  py.FS.writeFile(`${site}/tabcomputer_nb_mpl.py`, NB_MPL_PY);
  for (const [pkg, files] of Object.entries(NB_STUBS)) {
    // (the real package wins when Pyodide or the tab's pip has it)
    if (py.runPython(`import importlib.util; importlib.util.find_spec(${JSON.stringify(pkg)}) is not None`)) continue;
    for (const [path, text] of Object.entries(files)) {
      py.FS.mkdirTree(`${site}/${path.slice(0, path.lastIndexOf('/'))}`);
      py.FS.writeFile(`${site}/${path}`, text);
    }
  }
}

/** Run the kernel until the page closes it; resolves with the process's exit status. */
export async function runNotebookKernel(py: any, start: NotebookStart, cwd: string, env: Record<string, string>, io: NotebookIo): Promise<number> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const send = (msg: unknown) => io.ctlWrite(enc.encode(JSON.stringify(msg) + '\n'));

  let pending = new Uint8Array(0);
  const buf = new Uint8Array(65536);
  /** The next line from the page; null when a signal ended the wait; undefined when the page closed it */
  const readLine = (): string | null | undefined => {
    for (;;) {
      const nl = pending.indexOf(10);
      if (nl >= 0) {
        const line = dec.decode(pending.subarray(0, nl));
        pending = pending.slice(nl + 1);
        return line;
      }
      const n = io.ctlRead(buf);
      if (n === -EINTR) return null;
      if (n <= 0) return undefined;
      const next = new Uint8Array(pending.length + n);
      next.set(pending);
      next.set(buf.subarray(0, n), pending.length);
      pending = next;
    }
  };

  py.setStdin({ read: () => 0 });
  py.setStdout({ write(b: Uint8Array) { io.write(1, b); return b.length; } });
  py.setStderr({ write(b: Uint8Array) { io.write(2, b); return b.length; } });
  const napWord = new Int32Array(new SharedArrayBuffer(4));
  py.registerJsModule('tabcomputer_nbjs', {
    send: (text: string) => { io.ctlWrite(enc.encode(String(text) + '\n')); },
    /**
     * time.sleep(): wait here, in slices, and return true as soon as Stop is pressed. Pyodide's own
     * sleep switches stacks where the engine can, and the interrupt is then raised in whatever
     * Python runs first when it comes back (a weak reference's callback, which ignores it), so a
     * loop around sleep never stopped.
     */
    sleep: (seconds: number) => {
      const end = performance.now() + Math.max(0, Number(seconds) || 0) * 1000;
      for (;;) {
        if (io.interrupted()) { io.clearInterrupt(); return true; }
        const left = end - performance.now();
        if (left <= 0) return false;
        Atomics.wait(napWord, 0, 0, Math.min(left, 40));
      }
    },
    /** Ask the page and wait for the reply that carries `rid`; undefined (Python's None) when interrupted */
    request: (text: string, rid: number) => {
      io.ctlWrite(enc.encode(String(text) + '\n'));
      for (;;) {
        const line = readLine();
        if (line === undefined) throw new Error('the notebook was closed');
        if (line === null) { io.clearInterrupt(); return undefined; }
        try {
          const m = JSON.parse(line);
          if (m?.t === 'reply' && m.rid === rid) return line;
        } catch { /* not ours */ }
      }
    },
  });

  installKernel(py);
  const nb = py.pyimport('tabcomputer_nb');
  const pyEnv = py.toPy(env);
  const pySites = py.toPy(start.sitePaths);
  const version = String(nb.init(pyEnv, pySites, cwd));
  pyEnv.destroy();
  pySites.destroy();

  const load = async (packages: string[] | undefined, code: string | undefined) => {
    const opts = {
      messageCallback: (t: string) => { if (/^Loading /.test(t)) send({ t: 'status', text: t }); },
      errorCallback: (t: string) => { io.write(2, enc.encode(`${t}\n`)); },
    };
    try {
      if (packages?.length) await py.loadPackage(packages, opts);
      // (IPython and matplotlib_inline are answered by the stand-ins here: Pyodide's own IPython has no
      // notebook to draw in, and its display() only prints)
      if (code) await py.loadPackagesFromImports(code.replace(/^[ \t]*(?:from|import)[ \t]+(?:IPython|matplotlib_inline)\b.*$/gm, ''), opts);
    } catch (e: any) {
      io.write(2, enc.encode(`Could not load a package: ${e?.message ?? e}\n`));
    }
    send({ t: 'status', text: '' });
  };

  send({ t: 'ready', python: version });
  for (;;) {
    const line = readLine();
    if (line === undefined) return 0;
    if (line === null) continue; // (an interrupt with nothing running)
    let m: any;
    try { m = JSON.parse(line); } catch { continue; }
    if (m?.t === 'shutdown') return 0;
    if (m?.t === 'load') {
      await load(m.packages, m.code);
      send({ t: 'done', id: m.id, status: 'ok', count: 0 });
    } else if (m?.t === 'exec') {
      await load(m.packages, m.code);
      let result = { status: 'error', count: 0 };
      // A cell that waits in an await runs no Python, so Python does not see an interrupt: cancel its task
      const watch = setInterval(() => {
        if (!io.interrupted()) return;
        io.clearInterrupt();
        try { nb.cancel_current(); } catch { /* the cell ended meanwhile */ }
      }, 100);
      try {
        // (Stop pressed while the packages were loading: the cell does not start)
        if (io.interrupted()) throw new Error('KeyboardInterrupt');
        result = JSON.parse(String(await nb.run_cell(String(m.code))));
      } catch (e: any) {
        // (Python itself failed, or an interrupt landed outside the cell)
        const text = String(e?.message ?? e).trimEnd();
        send({ t: 'error', ename: 'KernelError', evalue: text.split('\n').pop() ?? '', traceback: text.split('\n') });
      }
      clearInterval(watch);
      io.clearInterrupt();
      send({ t: 'done', id: m.id, ...result });
    }
  }
}
