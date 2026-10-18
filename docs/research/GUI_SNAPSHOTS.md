# Snapshots of started GUI apps

Status (2026-10-13): working, with the safety rules and the background
retake below, and **still off unless set**
(`localStorage['tabcomputer-gui-snapshots'] = '1'`). With it on, an app's
first plain start is kept once its window is up and it has gone quiet, and
the next launch rebuilds its processes from that instead of running the
program: Geany's window is back 0.3 to 0.5 s after the click instead of 5.6
to 6.2 s, GIMP's main window after 0.9 to 1.0 s instead of 15 to 16 s,
Inkscape's after 0.5 to 0.7 s instead of 13 to 14 s ("The launch table"). A
snapshot that a quit outdated (GIMP saves its settings every time) is taken
again in the background, from a start nobody sees, so the next launch is a
restore all the same ("Retakes"). Eleven of the corpus's thirteen apps
restore (xeyes, xclock, Dillo, GPicView, L3afpad, Galculator, Geany,
Mousepad, FeatherPad, Inkscape, GIMP); the two terminals don't (a shell on a
pty).

The one restore failure seen (in 1 of 12 runs of the test with L3afpad, its
restored process ended at once with SIGABRT) is explained and fixed: the X
requests kept could include ones the process sent after its image (#142,
"Before it can be on by default"). The setting is still off by default
until that list is decided.

Code: `src/gui/snapshot.ts`, `src/gui/snapshot-setting.ts`,
`src/gui/retake.ts`, the launcher in `src/gui/apps.ts`, `src/x11/display.ts`
(`recordXClient`, `adoptXClient`), Blink patch 0551. Tests:
`tests/browser/gui-snapshot.mjs` (real apps),
`tests/browser/gui-snapshot-rules.mjs` (each rule below, and the retake),
`gui-snapshot.test.ts`, `gui-snapshot-take.test.ts`, `gui-retake.test.ts`, `x11.test.ts`,
`x86-engine.test.ts`.

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

The X requests kept are the ones recorded at that check, copied in the
same turn of the event loop, with the client's sequence number then
(`meta.x.seq`). The process runs on while the rest is looked at and
packed, and a request it sends meanwhile is not in its image: kept as
well, it would put the server's sequence number ahead of the restored
process's, and Xlib aborts at the first event it reads (#142, "Before it
can be on by default"). A restore checks that the replay ends at that
sequence number, and refuses the snapshot (a usual start) when it does not.

### What a snapshot is good for (validity)

`snapshotKey` is everything known before the process runs: the build, the
engine's version (the directory the Blink engine is loaded from, which is
named by the content of its files, so a rebuilt engine is another key), the
app, its arguments and environment, its packages with their versions, the
screen's size and DPI, and the text mode. A launch with arguments (a file to
open) never uses a snapshot. `keyChange` says which part differs ("the
engine", "the screen").

Beyond the key, the kernel logs every path the processes open, look at
(`stat`, `access`) or list while they start (`proc.data.openLog`, inherited
by children; a listed directory is logged as `path/`; 136 paths for xeyes,
several hundred for a GTK app), and the snapshot keeps what was at each. A
restore checks them all first. A library that changed, a font added, a
config file edited: the snapshot is dropped, the app starts the usual way,
and a new one is taken.

| Path | What is kept and compared |
|---|---|
| Not there | That it is not there: a settings file made since outdates the snapshot (GTK looks for `gtk.css` with `stat` and never opens it) |
| A system file (`/usr`, `/etc`, `/lib`, `/var`, …): the app's binary, its libraries | Size and time. The binary is in the list whether or not the log has it |
| A settings file: under a dot name in a home directory | Its lines, whatever their order (below) |
| Any other file (a document under `/home`, a file in `/tmp` the app did not write) | Its bytes. Geany starts with the files of its last session open: one that was edited since outdates the snapshot, so a restore never shows old contents |
| A directory the app listed | The names in it |
| A directory it only looked at | That it is a directory |
| `/dev`, `/proc`, `/sys`, `~/.cache`; in `/tmp` what the app wrote itself; a path a socket of the app is bound to, or a link to one (Geany's instance socket) | Nothing: these change at every run |

Three more rules, each with a test (`gui-snapshot.test.ts`,
`tests/browser/gui-snapshot-rules.mjs`):

- **No snapshot of an app that read a sign-in.** A snapshot is the
  processes' memory. When a path in the log is a credential file
  (`src/credentials.ts`: `~/.netrc`, gh's `hosts.yml`, …) or text with a
  token in it, none is taken (`signInAmong`). `signout` deletes the snapshot
  database at once.
- **Two weeks at most** (`MAX_AGE_MS`): what these checks can't see is
  bounded by it.
- **A restored process that ends within 5 s, and not cleanly, is followed by
  a usual start** of the app. Its snapshot is dropped, and none is taken in
  the background until the build or a setting changes (`setSkip`).

Three rules keep that from being too strict:

- **Settings an app rewrites unchanged are still the same** (content, not
  time). The first time an app quits it often writes its settings for the
  first time (L3afpad, GPicView, GIMP's `unitrc`): that changes what its
  first snapshot was made from, so the second launch is a usual start too
  and the third is the first restore.
- **The same lines in another order are the same file.** GIMP rewrites
  `controllerrc` at every exit from a hash table: the same entries, in
  whatever order the table gives them (4 quits of 4 in a row, nothing
  touched). A settings file's signature is the hash of its sorted lines. The
  cost: a settings file where only the order changed, and the order means
  something, doesn't outdate a snapshot. A document is compared by its
  bytes.
- **Files under `~/.cache` don't count.** A cache is something the app does
  as well without, and babl rewrites its conversion cache at every exit of
  GIMP.

What is left is right: **an app that saves different settings when it
quits outdates its own snapshot.** The next start reads the new state, as it
must. Without a retake it is a usual start; with one ("Retakes") it is a
restore of a snapshot taken in the background meanwhile. Measured in the
test on 2026-10-12, before retakes, after the restored app was used and
quit at once:

| App | What it was used for | The next launch |
|---|---|---|
| Geany | a file opened, edited, saved, Ctrl+Q | restored (0.17 s) |
| L3afpad, FeatherPad, Dillo, xeyes, xclock, GPicView, Inkscape | typing, or nothing | restored |
| Galculator | a number typed | usual start: `galculator.conf` changed |
| Mousepad | text typed, closed | usual start: its GSettings keyfile changed |
| GIMP | a new image made, Ctrl+Q | usual start: `sessionrc` changed (its windows) |

So for GIMP the 0.8 s start followed only a session that left its windows
as they were. The background retake is what gets past that: half a minute
after such a quit (10 s of quiet, then 21 to 23 s of hidden start) the next
launch is a restore again.

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
  the work area's size, so another size means a usual start (laid out for
  the new size) and another snapshot.
- **The keyboard.** What the display told the client while its requests were
  played back was dropped, and what the client believes about the focus is
  from the session its snapshot was taken in (an app started hidden was
  never given the keyboard). After the replay each toplevel is told again:
  FocusOut and FocusIn with WM_TAKE_FOCUS for the one that has the keyboard,
  FocusOut for the others (`Rootless.refocus`).
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

## The setting

`src/gui/snapshot-setting.ts`. `localStorage['tabcomputer-gui-snapshots']`:
`1` on for the eleven tested apps (`SNAPSHOT_TESTED`), `all` on for every app
(how an app is tried before it joins the list), `0` off, unset the default,
which is off (`SNAPSHOT_DEFAULT_ON = false`). `TABCOMPUTER_GUI_SNAPSHOTS=0`
exported in `~/.profile` turns it off too, and safe mode always does.
Settings → Storage shows an "Open apps faster" switch only where the key is
set (or where the default is on): Off forgets every stored snapshot.

When `SNAPSHOT_DEFAULT_ON` is made true, the default is on only where the
tests have run: a Chromium browser that is not a phone's, with 4 GB of
memory or more (`snapshotDefaultOn`). Apps outside the tested list, other
browsers and Debian mode (apps from apt) start the usual way.

## Retakes

`src/gui/retake.ts`, `takeHidden` in `src/gui/apps.ts`. When an app quits,
and once 20 s after the page has loaded (for the three apps started most
recently this week), the snapshot is looked at. When it is gone or no longer
good, the app is started again where nobody sees it: its X client is marked
hidden (`Client.hidden`), so the display makes no window for its toplevels,
the dock gets no mark, the pointer is never over them and no key reaches
them. When it has gone quiet its snapshot is kept as for any start, and its
processes are killed (not asked to quit: an app that is asked saves its
settings, which is what outdated the last snapshot). The next launch is a
restore.

It waits for a moment when it takes nothing from the person
(`retakeDecision`, tested in `gui-retake.test.ts`):

- never in safe mode, in a guest, or with the setting off;
- never while the page is hidden;
- not until 10 s have passed without a key or button pressed anywhere on the
  page, since the quit, and with no app being installed or started;
- a key or button pressed in a GUI app, an app being started, or the page
  being hidden ends it at once: its processes are gone 0.15 to 0.2 s after
  the click, and it is asked for again later;
- one at a time; an app whose hidden start failed twice in a row is left
  alone for the rest of the page load; one that can take no snapshot (a
  shell on a pty, a sign-in read, never quiet) is remembered with its key
  and not started again for it;
- on a machine with less than 8 GB, only apps whose image is 64 MB or less
  (`retakeFits`; unit-tested only, this machine has 8 GB).

Measured by `tests/browser/gui-snapshot-rules.mjs` and
`gui-launch-bench.mjs --snapshots` (2026-10-13, an Apple M3 with 8 GB,
headless Chrome 155, a local build):

| App | Hidden start, to the snapshot kept | Memory of the browser's renderer processes: before → peak |
|---|---:|---|
| xeyes | 1.9 s | not measured |
| GPicView | 2.5 s | |
| L3afpad | 3.7 to 4.1 s | |
| FeatherPad | 5.0 s | |
| Galculator | 5.1 s | |
| Geany | 6.8 to 8.7 s | 437 → 676 MB, 431 → 838, 737 → 1186, 930 → 1060, 1143 → 1486 (five runs): 0.13 to 0.45 GB more |
| Mousepad | 7.2 to 7.5 s | |
| Inkscape | 16 s | |
| GIMP | 21 to 23 s | 551 → 1698 MB, 802 → 1064 (two runs): 0.26 to 1.15 GB more |

A hidden start costs what a usual start of the app costs, plus the image
while it is packed. The memory is back within seconds of its end, minus
what the browser keeps. Geany, L3afpad, Mousepad and GIMP outdate their
snapshot at every quit (window geometry, session files), so each quit of
those is followed by a hidden start.

## Storage

One IndexedDB database, `tabcomputer-gui-snapshots`: the images and X
requests per app (gzip), and an index that holds everything else, so that
validity, `doctor` and Settings never read an image. A restore reads a
snapshot's index entry and its images in one transaction, so a snapshot
saved meanwhile (a retake, another tab) is never read as one's metadata
with the other's images. Stored bytes per app,
from the test:

| xeyes | xclock | Dillo | GPicView | L3afpad | Galculator | Geany | Mousepad | FeatherPad | Inkscape | GIMP |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2.9 MB | 4.6 | 6.8 | 10.4 | 15.7 | 16.5 | 20.5 | 33.0 | 35.5 | 66.7 | 84.6 |

All eleven together are 298 MB. The cap is **256 MB** (`SNAPSHOT_CAP`):
room for the five largest at once (241 MB), and small beside a Debian
install. It is never more than a tenth of what the browser says the site may
still use, because storage that is not persisted is deleted whole when the
disk runs low, and snapshots must not be why. Past the cap the least
recently used snapshot goes (`evictions`; a restore counts as a use), and one
that is over the cap alone is not kept. `doctor` counts them in its storage
line: `… of which app snapshots 2.9 MB of at most 256 MB (xeyes 2.9 MB)`.

## The launch table

`tests/browser/gui-launch-bench.mjs` on 2026-10-13: an Apple M3 with 8 GB,
headless Chrome 155, a local build of this branch, a fresh browser profile
per app. Seconds from the click to the usable window. "Off" is the setting
off, which is also what Build 1023 does. "On" is `--snapshots`: each start
keeps its snapshot, and the next pass waits for the retake, as someone who
opens the app a minute later does. Cold includes the install from the local
mirror.

| App | Off: cold | warm | after a reload | On: cold | warm | after a reload |
|---|---:|---:|---:|---:|---:|---:|
| xeyes | 1.1 | 0.2 | 0.4 | 1.2 | **0.1** | **0.3** |
| xclock | 1.4 | 0.4 | 0.6 | 1.4 | **0.1** | **0.2** |
| Dillo | 2.0 | 0.7 | 1.1 | 1.9 | **0.2** | **0.2** |
| GPicView | 3.8 | 0.5 | 0.8 | 3.9 | **0.1** | **0.4** |
| L3afpad | 5.3 | 1.9 | 2.2 | 5.1 | **0.2** | **0.4** |
| Galculator | 7.3 | 4.1 | 4.1 | 7.5 | **0.1** | **0.4** |
| Geany | 9.1 | 5.6 | 6.2 | 9.2 | **0.3** | **0.5** |
| Mousepad | 8.6 | 5.2 | 5.5 | 8.0 | **0.4** | **0.4** |
| FeatherPad | 5.1 | 2.4 | 2.7 | 5.0 | **0.3** | 2.6 (a usual start: "its environment changed") |
| Inkscape | 19 | 13 | 14 | 18 | **0.5** | **0.7** |
| GIMP | 20 | 15 | 16 | 19 | **1.0** | **0.9** |
| xterm | 1.6 | 0.4 | 0.5 | no snapshot | | |
| QTerminal | 4.6 | 1.9 | 2.5 | no snapshot | | |

Bold is a restore. FeatherPad's start after the reload was a usual one in
this run: a variable of its environment differed between the hidden start
late in the page's life and the launch 1.5 s after the reload (not looked
into; in `gui-snapshot.mjs` it restores after a reload).

## Before it can be on by default

1. **A restored process that aborted: explained and fixed (#142).** On
   2026-10-13, in one run of `gui-snapshot.mjs` out of twelve with L3afpad,
   under heavy load, the process restored after a reload ended at once with
   wait status 134: SIGABRT that the guest raised itself (an engine abort
   ends a process with status 6, without the core flag). The cause was in
   `takeSnapshot`: it checked that no X byte had moved while the image was
   made, then looked at the descriptors again and fetched the display's
   session, and only then copied the X requests from the recording, while
   the process ran on. L3afpad's caret blinks (GTK redraws it about every
   0.6 s), and a blink that fell in that window was kept with an image that
   had not sent it. The replay then left the server's sequence number ahead
   of the process's, and Xlib aborts at the first event it reads:

   ```
   [xcb] Unknown sequence number while processing queue
   [xcb] Aborting, sorry about that.
   l3afpad: ../../src/xcb_io.c:278: poll_for_event: Assertion `!xcb_xlib_threads_sequence_lost' failed.
   ```

   On a quiet machine the window is a few milliseconds; on a loaded one it
   can take in a blink. Now the requests are copied in the same turn as the
   check, the snapshot keeps the client's sequence number (format 4: older
   snapshots are dropped and taken again), and a restore whose replay ends
   at another sequence number is refused, which gives a usual start. Every
   app that draws while it is idle (a blinking caret: Geany, Mousepad,
   FeatherPad) was exposed the same way.

   Measured on 2026-10-18 (Apple M3, 8 GB, headless Chrome 155, a local
   build; scripts in `~/dev/tc-tools/snap/`: `loop.mjs` restores one
   snapshot again and again, `cycle.mjs` takes a snapshot under load and
   restores it, each cycle a new one):

   | Build | Load | Result |
   |---|---|---|
   | before | restore only, 4 CPU burners (load average 10 to 12), every other launch at 4x CPU throttling, reloads, early launches, retakes | 66 restores of 72 launches (13 of a hidden start's snapshot), 0 failures |
   | before | take and restore, 6x CPU throttling, 4 CPU burners | 15 of 15 restored, 0 failures |
   | before | take and restore, a busy tab (a shell loop in the page) | 4 of 6 restored processes ended about 2.3 s later with exit status 1 and no output: their snapshots held 23 KB of X requests, taken early in the start (a good one holds 93 KB) |
   | before | take and restore, packing made 1.5 s slower (`__guiSnapshotPackDelayMs`) | 6 of 6 restored processes ended 43 to 61 ms later with status 134 and the Xlib assertion above |
   | before's capture, after's check at restore | a busy tab | 2 of 4 snapshots refused at restore, both of the 23 KB kind: "its X requests end at sequence number 185, not 183", two requests sent after the image |
   | after | packing made 1.5 s slower | 6 of 6 restored and running |
   | after | a busy tab | 14 of 14 restored and running, 11 of them of the 23 KB kind |
   | after | restore only, as the first row, L3afpad | 94 restores of 100 launches (47 of a hidden start's snapshot), 0 failures; the 6 usual starts (a quit that rewrote `l3afpadrc`, a retake ended by the launch) each took a new snapshot at 4x CPU throttling, and each was restored after |
   | after | restore only, as the first row, Geany | 88 restores of 100 launches, 0 failures; 12 usual starts (`geany.conf` rewritten by a quit, a retake ended by the launch), each followed by a new snapshot that restored |

   In a busy tab the same cause showed another way: the restored process
   ended with exit status 1 after about 2.3 s, with no output. Those
   snapshots were taken early in L3afpad's start (23 KB of X requests,
   against 93 KB once it is idle), while it still sent requests in bursts;
   a build with the old capture and the new check refused them at restore,
   two requests past the image each time. `gui-snapshot-take.test.ts` holds
   the race with a stand-in engine and display, `gui-snapshot-rules.mjs
   --only packed` with L3afpad (it fails on the old capture: "its X
   requests end at sequence number 272, not 243"), and `gui-snapshot.mjs
   l3afpad geany` and `--only rules` pass on the fixed build.

   A restore that still ends at once is kept with what it left: its status
   in words, the end of its output and the kernel log from the restore on,
   in `window.__guiSnapshots`, in a `gui:` line in `dmesg`, and in the
   profile (`restoreFailures()` in `src/gui/snapshot.ts`, localStorage
   `tabcomputer-gui-snapshot-failures`, the newest five), since the app is
   started the usual way at once and its output with it.
2. **One machine, one browser.** Chrome 155 on an 8 GB Mac, headless.
   Firefox, Safari, a 4 GB Chromebook and phones are not tried; the default
   would be Chromium on a desktop with 4 GB or more for that reason.
3. **A soak test**: restore, use for a long time, many restores in a row.
4. **Every quit of Geany, Mousepad, L3afpad and GIMP starts a hidden one**,
   7 to 23 s of one core each time. A snapshot that leaves out what these
   rewrite at exit and don't read back differently (window geometry) would
   avoid it; which files those are per app is not known.
5. **The session bus.** GIMP, Inkscape, Mousepad and FeatherPad start
   without it while snapshots are on for them, so a second invocation with
   a file (Files → Open with) starts a second instance instead of handing
   the file to the first.
6. **Two tabs of one profile** share the snapshots and each runs its own
   display. The atom table is merged when a tab saves it (`keepAtoms`), and
   a snapshot whose atoms don't fit is refused, but a hidden start in one
   tab while the app runs in the other is not prevented.

## Open problems

(Numbered from 3: the first two became "Retakes" and "Before it can be on
by default".)

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
   save the table. A tab now takes the other's atoms before it saves and
   when the other saves (`keepAtoms`), so the tables stay one unless both
   make a new atom at the same moment; then a snapshot from the other tab
   is refused and retaken. Past 4,000 names the table is no longer kept.
8. **55 apps** can hold a client number. A number is handed back when its
   app's snapshot is dropped for space, not otherwise.
9. **The screen.** Resizing the browser window between sessions outdates
   every snapshot (the key has the work area's size); the look after a page
   load takes the recent ones again at the new size. An app only needs the
   screen it was told about to still be plausible; a RANDR-style notice
   after the restore would let the key leave the size out.
10. **A file's time alone.** A settings file is compared by its lines and a
   document by its bytes, so an app that acts on a file's time and not its
   content (a rebuild check) is restored after a `touch`. A directory that
   was looked at and not listed counts only as being there, and this
   filesystem does not change a directory's time when a file is added: a
   font added to a font directory doesn't outdate a snapshot unless the app
   listed the directory or opened the font.
11. **A process tree needs all its pids**: later in a session, when one of
    them is taken, GIMP starts the usual way. Giving the apps' processes
    pids from a range of their own would make that never happen.
12. **Debian mode** (apps from apt): not wired; the key would take the
    package versions from dpkg.

## Trying it

```js
localStorage.setItem('tabcomputer-gui-snapshots', '1')   // then reload
```

Open Geany, wait a few seconds, quit it, and wait half a minute without
touching the page; open it again. `window.__guiSnapshots` lists what
happened (`taken`, `restored`, `retake: 'started'`, `retaken`, or why not),
and `window.__guiRetakes` is the queue. Settings → Storage → "Open apps
faster" → Off forgets them all.
