# gdb in tabcomputer (issue #108)

`gdb ./prog`, `break main`, `run` failed with `ptrace: Function not
implemented`: Blink has no ptrace. A C class needs `break`, `run`,
`next`/`step`, `print`, `bt`, a stop with a backtrace on a segfault, and
Ctrl-C. This note records the design chosen and why. What works, what is
verified and what remains is at the end.

## The two candidates

### a. Linux ptrace across kernel processes

What unmodified gdb (linux-nat) does to start a program, from its sources
(`fork-inferior.c`, `linux-nat.c`, `nat/linux-ptrace.c`, `amd64-linux-nat.c`):

1. Before the first `run` it probes the kernel by forking test children and
   tracing them (`linux_ptrace_test_ret_to_nx`, the `PTRACE_O_*` feature
   checks).
2. `fork()`; the child calls `personality(ADDR_NO_RANDOMIZE)`,
   `PTRACE_TRACEME` and execs `$SHELL -c "exec prog"` (startup-with-shell):
   two exec stops, each reported through `waitpid(__WALL)`.
3. `PTRACE_SETOPTIONS` (TRACESYSGOOD, TRACECLONE/FORK/VFORK/EXEC, EXITKILL),
   then reads `/proc/PID/status`, `/proc/PID/task`, opens `/proc/PID/mem` for
   all memory access, tries libthread_db.
4. Registers through `PTRACE_GETREGSET` (NT_PRSTATUS, NT_X86_XSTATE) with
   `GETREGS`/`GETFPREGS` as fallbacks, `PTRACE_PEEKUSER` for the debug
   registers, `PTRACE_GETSIGINFO` and `PTRACE_GETEVENTMSG` at stops.
5. Breakpoints are `int3` bytes written into the tracee's text; it waits in
   `sigsuspend` for SIGCHLD and calls `waitpid(-1, WNOHANG|__WALL)`.

What that needs here:

- Tracer and tracee are different Workers, each with its own Blink instance
  and wasm memory. The kernel (the page) can reach neither memory: every
  PEEK/POKE/GETREGS, and every read of `/proc/PID/mem`, has to be forwarded
  to the tracee's Worker and answered by it while it is stopped. The only
  thing a stopped Blink thread can do is sit in a kernel call, so the
  tracee needs a "stopped, serving requests" loop in any case. That loop is
  the same piece candidate b needs; ptrace adds a second protocol on top.
- Ptrace stops in the kernel's process model: a new process state, wait4 and
  waitid reporting it to the tracer only (not the parent), SIGCHLD to the
  tracer, exec stops, signal-delivery stops, `PTRACE_O_*` events, reparenting
  to the tracer. `src/kernel/signals.ts` and `wait4` are shared by every
  process on the machine; a mistake there breaks job control for everybody.
- `int3` in text: Blink raises SIGTRAP (`HaltMachine(m, 3)`), but the wasm
  JIT (`wjit.c`) compiles hot code and would have to drop compiled regions
  when a debugger writes into them, from another process.
- gdb's probes at step 1 fail in undocumented ways when a feature is half
  there, and each failure is a message a student cannot act on.

A large change to shared kernel code, with a long tail of gdb-visible
details, before the first breakpoint works.

### b. A remote-protocol target next to the CPU state

gdb's remote target needs far less from the other side (`remote.c`). At
`target extended-remote`: `qSupported`, `vMustReplyEmpty`,
`QStartNoAckMode`, `!`, `Hg0`, `qTStatus`, `?`. At `run`:
`vRun;<hex file>;<hex args>` answered by a stop reply, then
`qXfer:features:read:target.xml`, `qXfer:auxv:read`, `g`, `m`, `Z0`,
`vCont;c` / `vCont;s`. Nothing probes the kernel, nothing forks, and gdb
never calls ptrace or wait.

- PIE: gdb gets the load address by comparing `AT_ENTRY` from
  `qXfer:auxv:read` with the file's entry (`svr4_exec_displacement`), and
  finds the dynamic linker from `AT_BASE`. The auxv is on the initial stack,
  so the stub reads it from memory at the first stop.
- Shared libraries: gdb plants a breakpoint in the dynamic linker
  (`_dl_debug_state` or its SDT probes) and walks `r_debug`/`link_map` with
  plain memory reads. A `Z0` and `m` are enough; `set sysroot /` makes it
  read the libraries' symbols from the filesystem rather than over the
  protocol.
- Breakpoints as `Z0`/`z0` are addresses kept by the stub, not bytes in
  memory, so nothing is written into code and no compiled code has to be
  invalidated. With `swbreak+` the stop is reported at the breakpoint's own
  address.
- `run` needs `target extended-remote` and `set remote exec-file`; a system
  gdbinit does both from `hook-run`, so the student types what the textbook
  says.

## Chosen: b, split between the engine and the page

- **In Blink (patch 0550, `blink/shiro.inc`, `signal.c`, `throw.c`,
  `blink.c`)**: a debug agent with no protocol knowledge. When host.mjs
  starts a process with `gdb: true`, the main thread keeps its `attention`
  flag set, so every instruction goes through the slow path the interpreter
  already has for signals (`CheckForSignals`); there the agent checks the
  breakpoint list, runs one instruction in the interpreter, and stops when
  told to. A stop is a loop of kernel calls (`SYS_shiro_debug`, 1050): the
  thread reports the stop, the kernel answers with a command (read or write
  memory, read or write registers, add or remove a breakpoint or a
  watchpoint, continue, step, detach), the thread carries it out and reports
  back. A watchpoint is memory compared after each instruction; a step can
  carry an address range (gdb's range stepping), so `next` over a line is
  one request however many instructions the line runs. Signals
  (pending ones, and faults raised by an instruction) become stops instead
  of being delivered; the resume command says whether to deliver the
  signal, as with ptrace. A blocking kernel call a signal interrupts stops
  where it is, and when the debugger keeps the signal the call is made
  again, so Ctrl-C during `scanf` does not make the read fail with EINTR.
- **In the page (`src/x86-engine/gdbserver.ts`)**: `tabcomputer-gdbserver`,
  a kernel program that speaks the remote protocol on fds 0/1. gdb starts
  it with `target extended-remote | tabcomputer-gdbserver`. On `vRun` it
  spawns the program in Blink as its child, with gdb's own stdin, stdout,
  stderr, session and process group (so the program reads the terminal),
  and answers `g`/`m`/`Z0`/`vCont` by handing commands to the stopped
  thread's pending `SYS_shiro_debug` call. Register layout, the target
  description, the auxv and the packet framing are TypeScript.
- **`/etc/gdb/gdbinit.d/tabcomputer.gdb`** (`src/x86-engine/gdbinit.ts`,
  written at boot with the PATH shims): `set sysroot /`, and
  `hook-run`/`hook-start`/`hook-starti` that connect and set the remote
  exec-file.

Why this one:

- No cross-process memory or register access: the thread that owns the CPU
  state answers for it. The kernel only pairs a pending call with a
  command.
- Nothing shared changes behaviour: no new process state, no change to
  wait4, signals or job control. The new syscall number is answered only
  for a process a gdbserver started.
- Cost when no debugger is attached: none in the instruction loop. The
  hooks are in `CheckForSignals` (already the slow path, entered only when
  `attention` is set), in `ConsumeSignal` and `DeliverSignalToUser` (signal
  delivery) and in a thread's `tkill` of itself; each is one load of a
  global that is false. Measured (a sieve, 100,000 `getppid` calls, 20,000
  `raise` calls with a handler and a 30M-iteration loop, static musl, under
  Node, three alternating rounds against the engine before the patch): no
  difference beyond run-to-run noise in any of the four. The wasm JIT is untouched; a debugged process runs
  in the interpreter, undebugged ones as before.
- The protocol half is TypeScript and is tested without the engine (a
  scripted client against a fake tracee), and with it (a scripted client
  against a real program in Blink), and with Debian's gdb when the `c`
  layer is available to the test.

Costs accepted:

- A debugged program runs interpreted, one instruction per loop turn with a
  breakpoint check: slower than normal, fine for class programs.
- One thread: only the main thread is debugged; other threads run freely
  and gdb is told there is one thread. Children of the program (fork, exec)
  are not debugged.
- `attach PID`, read and access watchpoints (`rwatch`, `awatch`), `catch
  syscall`, core files and reverse debugging are not provided.
- strace and anything else that calls ptrace still get ENOSYS.

## Where it stands

How each thing was checked: `tests/tests/shiro-vitest/gdb.test.ts`. "gdb"
is Debian's gdb 16.3 from the `c` toolchain layer, run under Node by the
test with `TABCOMPUTER_TEST_LAYERS=DIR` (a copy of the layer), in batch mode
and typed at a pty; the program is `fixtures/x86/gdbdemo.c` built in the
test by Debian's gcc, a dynamically linked PIE. "client" is a scripted
remote-protocol client against the same program built static, which runs
wherever the fixture can be built (gcc, or `zig cc`). Not checked in a
browser.

| | gdb | client |
|---|---|---|
| `break` by function and by file:line, `tbreak`, `run`, `start`, `continue` to the exit, a second `run` | yes | yes |
| `bt`, `up`/`down`, `info frame`, `info locals`, `print` of ints, doubles, structs, arrays, strings, `x`, `ptype`, `info registers`, `$xmm0` | yes | registers, memory |
| `next`, `step`, `finish`, `until`, `stepi`, `nexti` (a source line is one request: range stepping) | yes | yes |
| `set var`, `print f(1, 2)` (a call in the program) | yes | register and memory writes |
| `watch` (the engine compares the memory after each instruction) | yes | yes |
| a segfault, a division by zero, `abort()`: a stop with a backtrace, then the program's death by that signal | yes | yes |
| Ctrl-C while it computes and while it reads the terminal; the read goes on after `continue`; a Ctrl-C at the prompt is gdb's alone | yes (pty) | yes |
| the program reads what is typed at the terminal | yes (pty) | |
| `run ARGS`, `run < in > out 2>&1`, `--args` | yes | |
| `kill`, `quit` with a live program | yes | yes |
| a breakpoint in libc (`break printf`), `info sharedlibrary` | by hand | |
| C++ (`break`, `bt`, `finish` in a program using `<vector>`, `<iostream>`) | by hand | |

"By hand": run once from a scratch test, not kept as a test.

## What remains, in order

1. **A browser run.** Everything above ran under Node. The pieces that
   differ in a page (the Worker, `TextDecoder` on shared memory, the
   terminal) are the ones every Blink process already uses, but
   `gdb ./prog` typed into a tab is unverified.
2. **Threads.** Only the thread the program starts with is debugged. Other
   threads run freely: a breakpoint in a function they run is not hit, and
   they keep running while the main thread is stopped. gdb is told there is
   one thread. Doing it properly means stopping every thread at a stop
   (they would each take the `attention` path and park), thread ids in stop
   replies, and `qXfer:threads:read`.
3. **Children.** A fork or exec child is not debugged (`set follow-fork-mode
   child` has no effect), and a program that execs runs on undebugged.
4. **Speed of a debugged program.** It runs in the interpreter with a
   check per instruction: fine for class programs, slow for a long
   computation between breakpoints. With no breakpoint or watchpoint set
   and no step in progress, the thread could go back to compiled code and
   come back for signals only.
5. **Libraries' pretty-printers.** gdb reports `No module named
   'libstdcxx'` once for a C++ program; `print v` of a `std::vector` shows
   the raw members. (The same gdb would do that on any target here.)
6. **`attach PID`, `strace`, `ltrace`, `catch syscall`, core files.** These
   need ptrace or kernel support that isn't there; `attach` fails with
   gdb's ptrace error.
7. **gdb's TUI (`gdb -tui`, `layout src`)** is untested.
8. `info proc mappings` warns: gdb reads `/proc/PID/maps`, which exists for
   a process's own pid only.

## Found on the way

- A statically linked musl program's `abort()` never ended the process,
  with or without a debugger: musl raises SIGABRT with every signal
  blocked, the engine acts on it by its own mask when the mask is restored,
  and the kernel, last told the blocking mask, held the signal the engine
  killed itself with. host.mjs's `shiroKill` now unblocks the signal in the
  kernel first (covered by gdb.test.ts).

## Building the engine on macOS

`vendor/blink/build.sh` assumes Linux. On this Mac (Apple Silicon) it ran
with: emsdk 6.0.11 installed in a scratch directory (Homebrew's emcc is a
different version and needs a newer Python than the system's), GNU make
4.4.1 built from source (the Makefile refuses 3.81), Blink's
`tool/flock.c` compiled natively onto PATH (configure otherwise builds it
with emcc), `BLINK_WORK` in a scratch directory, and one line after
`./configure` to define `HAVE_SEEKDIR` in `config.h` (the probe runs under
node with the host's `/tmp`, a symlink on macOS, and comes out wrong). With
that, unmodified main rebuilds to a blink.wasm of the committed size.
