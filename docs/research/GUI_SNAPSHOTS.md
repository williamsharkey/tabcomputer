# Snapshots of started GUI apps

Status: a working prototype behind a setting that is off. With
`localStorage['tabcomputer-gui-snapshots'] = '1'`, an app's first plain start
is kept once its window is up and it has gone quiet, and the next launch
rebuilds its processes from that instead of running the program. In a
freshly loaded page Geany's window is back 0.3 s after the click instead of
5.9 s, GIMP's main window after 0.8 s instead of 16 s, Inkscape's after 0.6 s
instead of 13 s. The restored apps work: Geany opens a file through its file
dialog, takes typing, saves and quits with Ctrl+Q; GIMP makes a new image
through its dialog and quits. A snapshot is good until the app saves
different settings: GIMP does after most sessions, and then its next start
is a usual one ("What a snapshot is good for"). Eleven of the corpus's
thirteen apps restore
(xeyes, xclock, Dillo, GPicView, L3afpad, Galculator, Geany, Mousepad,
FeatherPad, Inkscape, GIMP); the two terminals don't (a shell on a pty).

Code: `src/gui/snapshot.ts`, `src/x11/display.ts` (`recordXClient`,
`adoptXClient`), Blink patch 0551. Tests: `tests/browser/gui-snapshot.mjs`
(real apps), `gui-snapshot.test.ts`, `x11.test.ts`, `x86-engine.test.ts`.

Why: [GUI_LAUNCH.md](../GUI_LAUNCH.md) measured that a launch is the
toolkit's start-up computed by the x86-64 engine (Geany: a billion guest
instructions, 34 ms of kernel time). Caches don't shorten that. Not running
it does.

## What a started app is, here

Everything that has to be the same again for the program to go on:

| Where | What | How it is kept |
|---|---|---|
| Engine (Blink, wasm) | Guest memory: the page tables and every mapped page. Geany: 57 MB, most of it the libraries' file pages | The engine writes every page (patch 0014's fork snapshot); untouched anonymous pages as a count, no bytes |
| | Each thread's CPU: 16 registers, rip, flags, SSE and x87 state, FS/GS base (TLS), signal mask and alternate stack, tid, `clear_child_tid` | One record per thread (patch 0551) |
| | The process's signal table, brk and mmap cursor, resource limits, ELF auxiliary values | In the fork snapshot's header |
| | Compiled code (the wasm JIT's regions), decode and TLB caches | Dropped: rebuilt as the code runs |
| Kernel (the page) | Open files: stdio, files by path and offset, eventfds, pipes, socket pairs, inotify watches, a listening socket | A record per open file, made again at restore; processes name them by number, so a pipe between two of them is one object again |
| | Per process: its descriptor table, signal dispositions and mask as the kernel knows them, cwd, umask, environment, arguments, pid, parent | In the snapshot's metadata, set on the new processes |
| | Sessions, a controlling terminal, a pty's line discipline | Not kept: such apps aren't snapshotted |
| X server (the page) | The client's windows, pixmaps, GCs, cursors, glyph sets, pictures, properties, event selections, its resource-id base, its sequence number; atoms | The client's whole request stream is recorded and played again (below); the atom table is the profile's |
| Desktop | The windows' frames, placement, dock state | Follow from the X windows, as for any app |

## How it is built

### The image (Blink patch 0551)

`blink_shiro_checkpoint()` is called by the Blink worker's own thread (the
guest's threads are other threads: `PROXY_TO_PTHREAD`) when the page asks
(`blink-checkpoint`). It takes the engine lock, so no guest thread executes
while it looks. Every guest thread is then in one of three states:

- **between two instructions**, waiting for the lock in `Actor`: its
  registers are in its `Machine`; restored, it goes on at its rip;
- **in a system call that only waits**: `poll`, `ppoll`, `select`,
  `pselect6`, `epoll_wait`, a futex wait, `nanosleep`, `pause`. It is
  recorded on its `syscall` instruction (rip − 2) with the call's number back
  in rax (a wait stores −EINTR there while it waits, so `Machine` now keeps
  the number: `shiro_sysax`). Restored, it makes the call again, as Linux
  restarts an interrupted call. A wait is safe to run twice;
- **anywhere else**: in a system call that does something (a `read`, a
  `write`, an `openat` whose kernel round trip gave the lock up), in a
  signal handler, or in a page fault that is reading its file
  (`shiro_inkernel`). Then there is no checkpoint now: the call answers −1
  with the thread and the call, and the page asks again later.

That is the quiescent point: every thread parked in a wait. A GUI app is
there whenever it is idle: its main loop in `poll`, GLib's worker in
`poll`, pool threads in a futex (GIMP: 11 threads, all of them). A process
with fork children in its engine instance, or a writable shared mapping,
can't be checkpointed (−2).

The image is the fork snapshot of the main thread (`ShiroSnapshot`: a header
and runs of pages) read through a scratch `Machine`, then the thread
records, then a tail. `ShiroRestore` rebuilds memory as it does for a forked
child, gives the main thread its record's registers, and starts every other
thread as `clone` would, on a new `Machine` with its old tid. Taking GIMP's
150 MB image holds the lock for 40 to 180 ms.

### The X connection: record and replay

Serializing what the server holds for a client (a graph of windows,
pixmaps with their pixels, glyph sets, pictures) would tie the snapshot to
the server's internals. The server is deterministic instead: the same
requests in the same order build the same state (`x11.test.ts` checks it).
So `display.ts` keeps every byte the client sends from its connection setup
on (Geany: 0.5 MB by the time it is idle; GIMP: 39 MB, its splash and
images), and a restore plays them into a new client with the replies and
events thrown away, since the process read them the first time. The
client's sequence number ends where the process left it, its windows have
their pixels (the drawing requests ran again), and the window is on screen
after a replay of 10 ms for Geany and 100 ms for GIMP, before the process
exists. Then the client's toplevels are told where they are now (a
synthetic ConfigureNotify, as a window manager sends), and from there the
desktop's own placement and resizing reach the client as events, as for any
app.

Three things have to hold for the replayed client to be the process's:

- **Its client number.** Resource ids are the client's number << 21, and
  the process holds its ids. An app's snapshots always use the same
  number, one of 55 kept for this (200 to 254; `clientNumberFor`). A
  second instance of the app finds the number taken, starts the usual
  way and is not recorded.
- **Atoms.** The process holds atom ids. With the setting on, the server's
  atom table is the profile's: loaded when the server starts, saved as it
  grows (`keepAtoms`), so an atom keeps its id across page loads. A restore
  checks the snapshot's table against the server's and gives up if an id
  has another name.
- **Extensions' opcodes** are fixed by the build, which is in the key.

The server's clock (`time()`) is moved up to the snapshot's so the client
never sees a timestamp before one it has seen.

### Open files

`lookAtFiles` turns the processes' descriptor tables into records, and
`restoreSnapshot` makes each open file again, once, however many
descriptors and processes hold it:

| Open file | Restored as |
|---|---|
| The launcher's stdin and output buffer | The new launch's |
| The X socket | One end of a new socket pair; the display plays the requests into the other (`adoptXClient`) |
| `eventfd` | A new one with the same count and flags |
| inotify, nothing queued | A new instance; each watch added again under its old watch descriptor |
| A pipe whose every end is held by the snapshot's processes, empty | A new pipe (GIMP and its `script-fu`: two) |
| A connected socket pair with both sides held by them, nothing queued (Qt's signal sockets) | A new pair |
| A listening AF_UNIX socket bound to a path (Geany's instance socket) | Bound and listening again; the stale socket file is removed first |
| A regular file open read-only | Opened again by path, at its offset |
| Anything else: a connected socket to another process (D-Bus), a pty, a pipe to a process outside, a file open for writing, timerfd, signalfd, epoll, memfd | No snapshot: the reason is logged (`window.__guiSnapshots`) |

### Processes

A snapshot is the app's process and its descendants, each with its image.
Children are started again under their parent with their old pids
(`SpawnOptions.pid`): GIMP knows `script-fu` by pid, and `script-fu` its
parent. A snapshot with children is restored only when every one of its
pids is free, which it is in a fresh page before much else has run; a
single process restores with a new pid when its own is taken.

A child that is not an engine process (xterm's and QTerminal's shell is
tabcomputer's own `sh`, on a pty) can't be written out: those apps get no
snapshot.

### D-Bus

An app that holds a connection to the session bus can't be restored: the
daemon keeps its side (the client's unique name, match rules, owned
names). GIMP, Inkscape, Mousepad and FeatherPad use the bus only to hand a
second invocation's files to the running instance, and start fine without
it. With snapshots on they are started without the bus
(`SNAPSHOT_WITHOUT_BUS`). Other apps that connect say so and are left
alone.

### When it is taken

`snapshotWhenQuiet` watches a first start: after the app's first window
that isn't a splash screen, 1.5 s later, when no X byte has gone for
150 ms, it asks the engine for each process's image. Then it checks that
nothing moved while the images were made: the same X request bytes,
sequence number and bytes sent to the client as before, nothing queued on
the socket either way, no byte written to any pipe between the processes
(`Pipe.written`), the same descriptors. If something moved it tries again
(Geany's caret blinks twice a second: a try lands between blinks). It gives
up after 60 busy answers, when the process ends, and at the first key or
button press anywhere in the display: an image that every later launch
starts from must not hold what someone typed.

### What a snapshot is good for (validity)

`snapshotKey` is everything known before the process runs: the build, the
engine's version directory, the app, its arguments and environment, its
packages with their versions, the screen's size and DPI, and the text mode.
A launch with arguments (a file to open) never uses a snapshot.

Beyond the key, the kernel logs every path the processes open or look for
while they start (`proc.data.openLog`, inherited by children; 400 to 600
paths for a GTK app), and the snapshot keeps what was at each: nothing, a
directory, a system file's size and time, a file under `/home` by content
hash. A restore checks them all first. A library that changed, a font
added, a config file edited: the snapshot is dropped, the app starts the
usual way, and a new one is taken.

Three rules keep that from being too strict:

- **Settings an app rewrites unchanged are still the same** (content, not
  time). The first time an app quits it often writes its settings for the
  first time (L3afpad, GPicView, GIMP's `unitrc`): that changes what its
  first snapshot was made from, so the second launch is a usual start too
  and the third is the first restore.
- **The same lines in another order are the same file.** GIMP rewrites
  `controllerrc` at every exit from a hash table: the same entries, in
  whatever order the table gives them (4 quits of 4 in a row, nothing
  touched). A home file's signature is the hash of its sorted lines. The
  cost: a file where only the order changed, and the order means
  something, doesn't outdate a snapshot.
- **Files under `~/.cache` don't count.** A cache is something the app does
  as well without, and babl rewrites its conversion cache at every exit of
  GIMP.

What is left is right, and it is the feature's main limit today: **an app
that saves different settings when it quits outdates its own snapshot.**
The next start reads the new state, as it must, and is a usual start (a
new snapshot is taken from it). Measured in the test, after the restored
app was used and quit:

| App | What it was used for | The next launch |
|---|---|---|
| Geany | a file opened, edited, saved, Ctrl+Q | restored (0.17 s) |
| L3afpad, FeatherPad, Dillo, xeyes, xclock, GPicView, Inkscape | typing, or nothing | restored |
| Galculator | a number typed | usual start: `galculator.conf` changed |
| Mousepad | text typed, closed | usual start: its GSettings keyfile changed |
| GIMP | a new image made, Ctrl+Q | usual start: `sessionrc` changed (its windows) |

So for GIMP the 0.8 s start is what follows a session that left its
windows as they were; after most real sessions the next start is the
usual 15 s. Open problem 1 is how to get past that.

### What must never be shared

A snapshot holds the processes' memory: the user's environment, the paths
and contents of every file read from `/home`, whatever the toolkit cached.
It is stored in the profile's own IndexedDB (`tabcomputer-gui-snapshots`),
read only by the same origin, never sent anywhere and never offered to
another profile or user. A snapshot that could ship with the app would have
to be taken in a clean, fixed profile and proven free of anything per-user
(home paths, the machine id, random seeds, the hostname): not attempted.
Guests are their own origin: they get their own or none.

## Measurements

`tests/browser/gui-snapshot.mjs` on 2026-10-12: an Apple M3, headless
Chrome 155, a fresh browser profile per app. "First launch" is install and
start, to the usable window. "Restored" is from the click in a reloaded
page to the app's usable window, and to its process running (a guest thread
waiting in a kernel call again). "First key" is from a key press to the
window showing it, on the restored app, with the JIT cold.

| App | First launch | Image | Stored (gzip) | X requests | Taking it | Restored after a reload: window | process running | Restored again, same page | First key shown |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| xeyes | 1.0 s | 6.5 MB | 2.9 MB | 2 KB | 0.14 s | **155 ms** | 184 ms | 65 ms | — |
| xclock | 1.3 s | 10 MB | 4.6 MB | 5 KB | 0.20 s | **195 ms** | 227 ms | 62 ms | — |
| dillo | 1.9 s | 17 MB | 6.8 MB | 0.7 MB | 0.28 s | **313 ms** | 362 ms | 97 ms | 36 ms |
| gpicview | 3.5 s | 25 MB | 10 MB | 49 KB | 0.43 s | **231 ms** | 273 ms | 97 ms | — |
| l3afpad | 5.0 s | 41 MB | 16 MB | 93 KB | 0.69 s | **370 ms** | 423 ms | 132 ms | 96 ms |
| galculator | 6.1 s | 43 MB | 16 MB | 1.1 MB | 0.78 s | **368 ms** | 439 ms | usual start (~/.config/galculator/galculator.conf changed) | 146 ms |
| geany | 8.0 s | 57 MB | 20 MB | 0.5 MB | 0.92 s | **317 ms** | 388 ms | 162 ms | — |
| mousepad | 7.9 s | 89 MB | 33 MB | 0.2 MB | 1.39 s | **317 ms** | 413 ms | usual start (~/.config/glib-2.0/settings/keyfile changed) | 210 ms |
| featherpad | 4.4 s | 89 MB | 36 MB | 3.8 MB | 1.49 s | **324 ms** | 432 ms | 239 ms | 399 ms |
| inkscape | 17.6 s | 199 MB | 67 MB | 4.5 MB | 3.27 s | **579 ms** | 767 ms | 403 ms | — |
| gimp | 18.5 s | 180 MB | 85 MB | 39 MB | 3.36 s | **823 ms** | 1006 ms | usual start (~/.config/GIMP/2.10/unitrc changed) | — |
| xterm | 1.4 s | no snapshot: process 106 (sh) is not one the engine can write out now | | | | | | | |
| qterminal | 4.3 s | no snapshot: process 105 (sh) is not one the engine can write out now | | | | | | | |

- **Restore time** is the X replay (5 to 20 ms; GIMP 100 ms), unpacking the
  image (gzip: 8 to 350 ms, overlapped with the replay) and starting a
  Blink worker with it. The window is up before the process runs: for
  Geany 317 ms against 388 ms.
- **Size.** The image is the whole address space; gzip brings it to 34 to
  45% (GIMP's stored 85 MB includes its 39 MB of X requests). Taking one
  costs 0.1 to 3.4 s, almost all of it gzip in the page.
- **A second restore in the same page** is faster (the engine's wasm is
  compiled, the snapshot module loaded): 60 to 400 ms.

## What works after a restore, and what does not

Checked by the test, per app: after a reload the app is restored, it is
used, it quits and leaves no process, and it is restored again in the same
page.

| App | Used how, after the restore | Result |
|---|---|---|
| xeyes | The pointer moved from one eye into the other | The pupils follow |
| xclock, GPicView, Inkscape (its welcome dialog) | Left running, then closed | The process runs on and ends cleanly |
| Dillo | Ctrl+L, typed into the location bar | Shown |
| L3afpad, Mousepad, FeatherPad | Typed into the editor | Shown; the "save changes?" dialog comes at close |
| Galculator | Digits typed | Shown |
| Geany | Ctrl+O, a path typed into the file dialog, Enter; typed into the file; Ctrl+S; Ctrl+Q | The file opens, the title shows it changed, the saved file has the text, exit status 0, no process left |
| GIMP | Ctrl+N, Enter in the New Image dialog; Ctrl+Q | The dialog opens (2.4 to 3 s: cold JIT), the image window comes, GIMP and `script-fu` exit with status 0 |
| xterm, QTerminal | | No snapshot: their shell is a child on a pty |

Not checked: the clipboard after a restore, drag and drop, printing, an
input method, a second monitor scale, audio, anything through a GIMP
plug-in or Script-Fu, and long sessions after a restore.

What a restored app can notice:

- **Time.** The engine's monotonic clock is the page's epoch-based one
  (`performance.timeOrigin + now`), so it jumps forward by however long the
  snapshot lay stored. GLib timers that came due fire once; nothing waits
  for an old time to return. Wall-clock time is simply now (Geany's status
  pane stamps its lines with the right time).
- **Its pid.** The process gets the pid it had when no process has it, the
  usual case. A single process whose pid is taken gets a new one: then
  `getpid()` is right, glibc's cached tid of the main thread is the old one
  (`raise` or `pthread_kill` aimed at the main thread would miss), and
  `_NET_WM_PID` names the old pid (the launcher maps it to the app).
- **Temporary files.** `/tmp` is the tab's filesystem and survives a
  reload, so a file the process had open by path is there. A file it had
  unlinked while open is gone: such a descriptor refuses the snapshot.
- **The screen** is the one it was told at connection setup: the key has
  the work area's size, so another size means another snapshot.
- **Compiled code is gone.** The restored process starts with the JIT cold:
  the first key is shown after 40 to 400 ms, GIMP's first dialog after 2.4
  to 3 s. A second use is as fast as ever.

## The alternatives

- **A snapshot before the X connection** (after linking and toolkit
  library init, no server state): needs no X work, but Geany's X connection
  is up 0.3 s into a 5.5 s launch. Nearly all the work comes after it:
  building widgets, CSS, the first layout. It would save about 5%.
- **Pre-warm**: start the app hidden at boot or on dock hover and show its
  window on the click. No engine or server work, and no validity question.
  But it spends the 2 to 16 s of engine time, a Worker per thread and the
  app's memory (60 MB for Geany, 180 MB for GIMP) for every app that might
  be opened, on every page load, and a hover gives 0.3 s of head start on a
  5.5 s launch. Worth it for one app the user always opens; not as a general
  mechanism.
- **A translated-code cache across page loads**: at most the 11 to 19% of a
  launch that is JIT compiling (GUI_LAUNCH.md). Its better use is after a
  restore, where it would remove the cold-JIT seconds above.

## Open problems

1. **A session that changes the app's settings costs the next start.**
   (Above: GIMP, Galculator, Mousepad.) The fix that keeps every setting
   honest is to take the new snapshot before the user asks: when an app
   quits and its snapshot is outdated, start it again hidden (its windows
   not shown), let it go quiet, keep its image, end it. The next click is a
   restore whatever the session did. It costs one start's worth of engine
   time in the background after such a quit, and needs windows the desktop
   doesn't show. The alternative, a list per app of files that may be stale
   (GIMP's `sessionrc`), restores fast with the window layout of an older
   session, which is a setting lost.
2. **Before it can be on by default.** It has run on eleven apps, on one
   machine, for minutes each. Wanted first: a way to turn it off per app
   and a listing in Settings (what is stored, how big, forget); eviction
   (snapshots are 3 to 85 MB each in IndexedDB and are only ever replaced);
   a soak test (restore, use for a long time, many restores in a row);
   Firefox and Safari; phones' memory.
3. **Ptys and non-engine children** (xterm, QTerminal): the line
   discipline's state, the session and foreground group, and a child that
   is tabcomputer's own shell rather than an engine process.
4. **D-Bus connections that matter** (an app that needs the bus to work).
   Replaying the client's side into a fresh daemon, as the X requests are
   replayed, needs the daemon to hand out the same unique name; or the
   daemon is snapshotted too.
5. **Image size.** The image holds every mapped page, including library
   pages that are byte for byte the file's. Recording those as (file,
   offset) from Blink's `FileMap` table and mapping the file again at
   restore would cut the images to their private pages and most of the
   gzip time with them.
6. **More kinds of open file**: files open for writing (the offset, and the
   file must be unchanged), timerfd (re-armed for the remaining time),
   epoll (the set, by descriptor), signalfd.
7. **Atoms across tabs.** Two tabs of one profile each run a server and
   save the table; the last save wins, and a snapshot taken in the other
   tab may then find an atom's id taken. It is dropped and retaken. A
   shared, append-only table (a lock, or a `BroadcastChannel`) would fix it.
8. **55 apps** can hold a client number; beyond that, numbers have to be
   handed back.
9. **The screen.** Resizing the browser window between sessions drops every
   snapshot (the key has the work area's size). An app only needs the
   screen it was told about to still be plausible; a RANDR-style notice
   after the restore would let the key leave the size out.
10. **Settings read with `stat` only** aren't in the open log (a file whose
   time an app checks without opening it), and a directory counts only as
   being there: a font added to a system font directory doesn't outdate a
   snapshot unless the app opened the font.
11. **A process tree needs all its pids**: later in a session, when one of
    them is taken, GIMP starts the usual way. Giving the apps' processes
    pids from a range of their own would make that never happen.
12. **Debian mode** (apps from apt): not wired; the key would take the
    package versions from dpkg.

## Trying it

```js
localStorage.setItem('tabcomputer-gui-snapshots', '1')   // then reload
```

Open Geany, wait a few seconds, quit it; open it again (twice, the first
time, while it writes its settings). `window.__guiSnapshots` lists what
happened (`taken`, `restored`, or why not).
`indexedDB.deleteDatabase('tabcomputer-gui-snapshots')` forgets them all.
