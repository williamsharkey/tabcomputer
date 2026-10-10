/**
 * Shiro kernel passthrough for the Blink wasm build (an emscripten --js-library).
 *
 * blink/shiro.inc (patch 0011) forwards the guest's fd, filesystem and
 * process syscalls to the Shiro kernel through shiro_ksys(). Guest threads
 * are pthreads; the call is proxied to the module's main thread (the Worker
 * host.mjs runs in), which returns a Promise, so the calling thread blocks
 * while the main thread stays free to serve every other thread's calls.
 * host.mjs implements Module.shiroKernel.call() over a pool of kernel
 * channels: a blocked read on one channel doesn't stall the others.
 *
 *   shiroKernel.call(nr, args: Int32Array(12), as, input: Uint8Array, outCap)
 *     -> Promise<{ r, hi, out: Uint8Array | null }>
 */

var ShiroKernelLibrary = {
  shiro_ksys__proxy: 'sync',
  shiro_ksys__async: 'auto',
  shiro_ksys: (nr, argsPtr, as, dataPtr, inLen, outCap) => {
    var K = Module['shiroKernel'];
    if (!K) return -38; // ENOSYS
    var args = HEAP32.slice(argsPtr >> 2, (argsPtr >> 2) + 12);
    var input = inLen ? HEAPU8.slice(dataPtr, dataPtr + inLen) : new Uint8Array(0);
    return K.call(nr, args, as, input, outCap).then((res) => {
      if (res.out && res.out.length) HEAPU8.set(res.out, dataPtr);
      HEAP32[argsPtr >> 2] = res.hi;
      return res.r;
    });
  },

  // fork(): hand the process snapshot (blink/shiro.inc) to the page, which
  // starts it in a new worker as `pid`
  // same-instance fork: tell the page this worker now hosts kernel process `pid`
  shiro_hosted__proxy: 'sync',
  shiro_hosted: (pid) => {
    var K = Module['shiroKernel'];
    if (K && K.hosted) K.hosted(pid);
  },

  // a thread waiting on a direct channel has a signal to take: ask the page
  // to interrupt the process's blocking calls (it answers with EINTR)
  shiro_kick__proxy: 'async',
  shiro_kick: () => {
    var K = Module['shiroKernel'];
    if (K && K.kick) K.kick();
  },

  shiro_fork_start__proxy: 'sync',
  shiro_fork_start: (pid, ptr, len) => {
    var K = Module['shiroKernel'];
    if (!K || !K.fork) return -38; // ENOSYS
    return K.fork(pid, HEAPU8.slice(ptr, ptr + len));
  },
  // Objects shared with other Blink instances (blink/shiro.inc, shmobj):
  // their bytes are a SharedArrayBuffer the kernel gave this thread
  // (host.mjs keeps them in shiroKernel.shm: id -> buffer), whose last page
  // is control words (the object's lock). Guest threads reach it here.
  shiro_shm_io__proxy: 'sync',
  shiro_shm_io: (id, off, ptr, n, dir) => {
    var sab = Module['shiroKernel']?.shm?.get(id);
    if (!sab) return -14; // EFAULT
    off >>>= 0;
    var lim = sab.byteLength - 4096;
    var k = Math.max(0, Math.min(n, lim - off));
    if (dir === 0) {
      if (k) HEAPU8.set(new Uint8Array(sab, off, k), ptr);
      if (k < n) HEAPU8.fill(0, ptr + k, ptr + n); // (past the object: zeros)
    } else if (k) {
      new Uint8Array(sab, off, k).set(HEAPU8.subarray(ptr, ptr + k));
    }
    return k;
  },
  // the bytes at ptr that differ from twin go to the buffer
  shiro_shm_diff__proxy: 'sync',
  shiro_shm_diff: (id, off, ptr, twin, n) => {
    var sab = Module['shiroKernel']?.shm?.get(id);
    if (!sab) return -14;
    off >>>= 0;
    n = Math.max(0, Math.min(n, sab.byteLength - 4096 - off));
    var dst = new Uint8Array(sab, off, n), i = 0, j;
    while (i < n) {
      if (HEAPU8[ptr + i] === HEAPU8[twin + i]) { i++; continue; }
      for (j = i + 1; j < n && HEAPU8[ptr + j] !== HEAPU8[twin + j]; j++);
      dst.set(HEAPU8.subarray(ptr + i, ptr + j), i);
      i = j;
    }
    return 0;
  },
  // The object's lock (control words: 0 held, 1 threads waiting for it).
  // Takes it (and copies the page at off into ptr, if ptr) and returns 1;
  // or returns 0 and sets *flag once it is worth trying again (a release,
  // or 100 ms). how: 1 the caller is already waiting (else a newcomer, who
  // lets the waiters go first), 2 take it regardless (its holder died).
  shiro_shm_acquire__proxy: 'sync',
  shiro_shm_acquire: (id, off, ptr, flag, how) => {
    var sab = Module['shiroKernel']?.shm?.get(id);
    if (!sab) return 1;
    var c = new Int32Array(sab, sab.byteLength - 4096, 2);
    if ((how & 2) || ((how & 1) || Atomics.load(c, 1) === 0) && Atomics.compareExchange(c, 0, 0, 1) === 0) {
      Atomics.store(c, 0, 1);
      if (how & 1) Atomics.sub(c, 1, 1);
      if (ptr) {
        off >>>= 0;
        var k = Math.max(0, Math.min(4096, sab.byteLength - 4096 - off));
        if (k) HEAPU8.set(new Uint8Array(sab, off, k), ptr);
        if (k < 4096) HEAPU8.fill(0, ptr + k, ptr + 4096);
      }
      return 1;
    }
    if (!(how & 1)) Atomics.add(c, 1, 1);
    var done = () => { Atomics.store(HEAP32, flag >> 2, 1); Atomics.notify(HEAP32, flag >> 2); };
    var r = Atomics.waitAsync ? Atomics.waitAsync(c, 0, Atomics.load(c, 0), 100) : { async: false };
    if (r.async) r.value.then(done); else done();
    return 0;
  },
  // Writes the page at ptr back to off (if ptr) and releases the lock
  shiro_shm_release__proxy: 'sync',
  shiro_shm_release: (id, off, ptr) => {
    var sab = Module['shiroKernel']?.shm?.get(id);
    if (!sab) return 0;
    if (ptr) {
      off >>>= 0;
      var k = Math.max(0, Math.min(4096, sab.byteLength - 4096 - off));
      if (k) new Uint8Array(sab, off, k).set(HEAPU8.subarray(ptr, ptr + k));
    }
    var c = new Int32Array(sab, sab.byteLength - 4096, 2);
    Atomics.store(c, 0, 0);
    if (Atomics.load(c, 1) > 0) Atomics.notify(c, 0);
    return 0;
  },
  // FUTEX_WAIT on a word of the buffer: 0 when watching (flag gets 2 on a
  // wake, 1 after ms), -11 if the word isn't `expect`, -38 without waitAsync
  shiro_shm_watch__proxy: 'sync',
  shiro_shm_watch: (id, off, expect, flag, ms) => {
    var sab = Module['shiroKernel']?.shm?.get(id);
    if (!sab) return -14;
    if (typeof Atomics.waitAsync !== 'function') return -38;
    var r = Atomics.waitAsync(new Int32Array(sab), (off >>> 0) >> 2, expect | 0, ms);
    var done = (v) => { Atomics.store(HEAP32, flag >> 2, v === 'ok' ? 2 : 1); Atomics.notify(HEAP32, flag >> 2); };
    if (!r.async) return r.value === 'not-equal' ? -11 : (done(r.value), 0);
    r.value.then(done);
    return 0;
  },
  shiro_shm_wake__proxy: 'sync',
  shiro_shm_wake: (id, off, n) => {
    var sab = Module['shiroKernel']?.shm?.get(id);
    if (!sab) return 0;
    return Atomics.notify(new Int32Array(sab), (off >>> 0) >> 2, n);
  },

  // Thread Workers: each is a JS engine instance (~12 MB), and every Blink
  // process is its own module, so build.sh starts two (the guest's main
  // thread and one spare) instead of four. A thread that takes the spare
  // has one loading behind it, so the next fork or pthread_create finds a
  // Worker ready (a cold one takes ~70 ms to start, a warm one ~10 ms).
  shiro_pool_init__deps: ['$PThread'],
  shiro_pool_init__postset: `
    if (!ENVIRONMENT_IS_PTHREAD) {
      var shiroGetNewWorker = PThread.getNewWorker;
      // compiled-code modules a thread posts (wjit.c): to the page, which
      // keeps them (every thread's Worker comes through here, the pool's too)
      var shiroKeep = function (d) {
        var K = Module['shiroKernel'];
        if (d && d.shiroWjModule && K && K.keepWasm) K.keepWasm(d);
      };
      PThread.getNewWorker = function () {
        var worker = shiroGetNewWorker.call(PThread);
        // its own kernel channel, before its thread runs (shiro.inc: direct
        // channels); the Worker keeps it for the threads it runs later
        var K = Module['shiroKernel'];
        if (worker && !worker.shiroDch && K && K.takeDch) {
          var dch = K.takeDch();
          if (dch) {
            worker.shiroDch = dch;
            worker.postMessage({ shiroDch: dch });
          }
        }
        if (worker && !worker.shiroKeep) {
          worker.shiroKeep = true;
          if (worker.addEventListener) worker.addEventListener('message', function (e) { shiroKeep(e.data); });
          else if (worker.on) worker.on('message', shiroKeep);  // (Node's worker_threads)
        }
        if (PThread.unusedWorkers.length == 0) {
          setTimeout(function () {
            if (PThread.unusedWorkers.length == 0) PThread.loadWasmModuleToWorker(PThread.allocateUnusedWorker());
          }, 0);
        }
        return worker;
      };
    } else {
      // a thread Worker: the kernel channel host.mjs gives it (above), for
      // shiro_dch_* (messages before its thread runs reach it here)
      var shiroTakeDch = function (d) {
        if (d && d.shiroDch) {
          globalThis.shiroDch = d.shiroDch;
          globalThis.shiroDchI32 = new Int32Array(d.shiroDch);
        }
      };
      var shiroPort = typeof process == 'object' && process.getBuiltinModule ? process.getBuiltinModule('worker_threads').parentPort : null;
      if (shiroPort) shiroPort.on('message', shiroTakeDch);
      else self.addEventListener('message', function (e) { shiroTakeDch(e.data); });
    }`,
  shiro_pool_init: () => {},

  // This thread's own kernel channel (shiro.inc's direct channels): a
  // SharedArrayBuffer the page serves, in the WASI guest channel's layout
  // (state, nr, result, signal, args, data at 64). Not proxied: they run on
  // the calling thread, which waits on the channel itself.
  shiro_dch_size: () => {
    var s = globalThis.shiroDch;
    return s ? s.byteLength - 64 : 0;
  },
  shiro_dch_post: (nr, args, data, inlen) => {
    var s = globalThis.shiroDch, w = globalThis.shiroDchI32;
    if (inlen) new Uint8Array(s, 64, inlen).set(HEAPU8.subarray(data, data + inlen));
    w[1] = nr;
    for (var i = 0; i < 12; i++) w[4 + i] = HEAP32[(args >> 2) + i];
    if (Atomics.compareExchange(w, 0, 0, 3) !== 0) return 0;  // closed (4)
    Atomics.notify(w, 0);  // the page's watch() waits on it
    return 1;
  },
  shiro_dch_state: () => Atomics.load(globalThis.shiroDchI32, 0),
  shiro_dch_cas: (o, n) => (Atomics.compareExchange(globalThis.shiroDchI32, 0, o, n) === o ? 1 : 0),
  shiro_dch_wait: (v, ms) => {
    Atomics.wait(globalThis.shiroDchI32, 0, v, ms);
  },
  // the reply: returns the result, the high word into args[0], the signal
  // that rode on it into *sig, outcap bytes of data
  shiro_dch_finish: (args, data, outcap, sig) => {
    var s = globalThis.shiroDch, w = globalThis.shiroDchI32, r = w[2];
    HEAP32[args >> 2] = w[4];
    Atomics.compareExchange(w, 0, 2, 0);
    HEAP32[sig >> 2] = Atomics.exchange(w, 3, 0);
    if (outcap) HEAPU8.set(new Uint8Array(s, 64, outcap), data);
    return r;
  },
};

addToLibrary(ShiroKernelLibrary);
