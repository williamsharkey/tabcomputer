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
  memory, read or write registers, add or remove a breakpoint, continue,
  step, detach), the thread carries it out and reports back. Signals
  (pending ones, and faults raised by an instruction) become stops instead
  of being delivered; the resume command says whether to deliver the
  signal, as with ptrace. A blocking kernel call interrupted by a signal is
  abandoned and its instruction run again after the stop, so Ctrl-C during
  `scanf` does not make the read fail with EINTR.
- **In the page (`src/x86-engine/gdbserver.ts`)**: `tabcomputer-gdbserver`,
  a kernel program that speaks the remote protocol on fds 0/1. gdb starts
  it with `target extended-remote | tabcomputer-gdbserver`. On `vRun` it
  spawns the program in Blink as its child, with gdb's own stdin, stdout,
  stderr, session and process group (so the program reads the terminal),
  and answers `g`/`m`/`Z0`/`vCont` by handing commands to the stopped
  thread's pending `SYS_shiro_debug` call. Register layout, the target
  description, the auxv and the packet framing are TypeScript.
- **`/etc/gdb/gdbinit.d/tabcomputer.gdb`** (written in Debian mode):
  `set sysroot /`, and `hook-run`/`hook-start`/`hook-starti` that connect
  and set the remote exec-file.

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
  delivery), and where a kernel call returns EINTR; each is one load of a
  global that is false. The wasm JIT is untouched; a debugged process runs
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
- `attach PID`, hardware watchpoints (`watch` falls back to gdb's
  single-stepping software watchpoints), `catch syscall`, core files and
  reverse debugging are not provided.
- strace and anything else that calls ptrace still get ENOSYS.
