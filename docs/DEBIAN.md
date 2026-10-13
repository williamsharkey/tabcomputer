# Debian in tabcomputer (unix/debian)

tabcomputer can run a real Debian system: Debian 13 "trixie" amd64, Debian's own
dynamically linked binaries (ld-linux-x86-64.so.2, glibc, apt, dpkg) running
in the Blink x86-64 engine as kernel processes, with tabcomputer's fast builtins
and WASM programs layered over the hot programs. This is the hybrid design:

```
debian install                     # stream the root filesystem in (nothing big is downloaded yet)
sudo apt update
sudo apt install -y hello jq
hello; jq --version; dpkg -l | tail
tabcomputer-alternatives --list          # which programs are tabcomputer's, which are Debian's
```

Status, numbers and the package scoreboard: [DEBIAN_SCORE.md](DEBIAN_SCORE.md),
[BENCHMARKS.md](BENCHMARKS.md) ("Debian").

## 1. The root filesystem, streamed

`scripts/debian/build-rootfs.sh` (run as root; it chroots) builds the image:

1. `debootstrap --variant=minbase trixie` from a pinned snapshot.debian.org
   timestamp (`SNAPSHOT`, default `20261001T000000Z`), with debootstrap and
   the archive keyring themselves pinned by sha256. debootstrap checks every
   package against the signed Release.
2. tabcomputer's customization: deb822 sources for trixie, trixie-updates and
   trixie-security (the real archive URLs), apt defaults
   (`/etc/apt/apt.conf.d/90shiro`: no translations, no recommends, downloads
   as root), Docker-slim style `path-exclude`s for docs, translated man
   pages and locales (English man pages are kept), `force-unsafe-io`, the
   `user` account (uid 1000, as the kernel runs everything), the hostname,
   and `/usr/sbin/policy-rc.d` exiting 101 so maintainer scripts don't start
   services, as in Debian's containers (`service NAME start` still does).
3. Reproducibility: file times clamped to `SOURCE_DATE_EPOCH`, logs, caches,
   machine-id and apt lists removed.
4. `scripts/debian/pack-rootfs.mjs` packs it into `public/debian/`:
   - `rootfs.json`: the manifest (Debian version, snapshot, sizes, index name);
   - `index-<id>.json.gz`: every path with type, mode, mtime and size, a
     symlink's target, or the (chunk, offset) holding a file's bytes;
   - `chunks/<sha256>.gz`: gzip chunks of ~768 KB, named by the sha256 of
     their uncompressed bytes. A Debian package's files are packed together
     (from dpkg's `.list` files), so running a program fetches its package's
     chunk and not much else. Identical files are stored once.

Old chunks stay when the image is rebuilt (`--prune` removes them): browsers
that installed an older image still fetch from them.

**Installing** (`debian install`, `src/debian/rootfs.ts`) fetches the
manifest and the index (≈60 KB) and writes every path as a *placeholder*
node (`FSNode.lazy`: mode, size, symlink target, no bytes) in one batch, so
the whole tree is visible at once: `ls`, `stat`, PATH lookups and dpkg's
database all work immediately. The first read of a file (`readFile`, or the
kernel opening it for a program) fetches its chunk, checks the sha256, keeps
the compressed chunk in the Cache API (`tabcomputer-debian-chunks-v1`) and stores
the file's bytes in IndexedDB like any other file. A warm boot needs no
network: everything read before is a normal file, and boot only reads
`/var/lib/shiro/rootfs.json` to re-attach the lazy loader. Conflicts with
tabcomputer's own files: Debian's replace them (`/etc/passwd`, `/bin/sh`), tabcomputer
directories that Debian makes symlinks (`/bin` → `usr/bin`) have their
contents moved to the target, and the `/usr/local/bin` shims tabcomputer writes
for its builtins are removed.

## 2. apt and dpkg

Debian's apt and dpkg run unmodified. What tabcomputer provides around them:

- **uid 0**: `sudo` (builtin, `src/commands/sudo.ts`) runs its command with
  kernel uid/gid 0 (`SpawnOptions.uid`, `Shell.uid`), which Blink forwards
  for getuid/geteuid/getgid. There is no password: the browser tab is the
  security boundary.
- **`apt` at the prompt** (#133): `apt`/`apt-get` `install`, `remove`,
  `update`, `upgrade` and the other commands apt keeps for root run as root
  without `sudo` when typed at tabcomputer's shell (`aptWantsRoot`,
  `shiroAptCmd`), as `apt` does before Debian mode. An install with no
  package lists runs `apt-get update` first, and one that ends in "Unable to
  locate package" fetches the lists and runs once more, unless this page
  fetched them in the last ten minutes (`src/debian/apt-guard.ts`). apt
  started by another program (Debian's sh, make) is not changed: there it
  needs `sudo`.
- **`#!` scripts** run as Linux runs them when the interpreter is a real
  program (the kernel's `shebangLoader`): dpkg's maintainer scripts run under
  Debian's dash (`/bin/sh`), perl scripts under Debian's perl.
- **The package mirror.** Browsers can't open TCP connections, so apt's
  http/https transport is tabcomputer's: `/usr/lib/apt/methods/http` is diverted
  to `http.debian` (see the overlay below) and replaced by a
  `#!/usr/bin/shiro-apt-method` stub, a tabcomputer kernel program
  (`src/debian/apt-method.ts`) that speaks apt's method protocol and fetches
  `http://HOST/PATH` from the page's own origin as `/debian/mirror/HOST/PATH`.
  apt still verifies InRelease with sqv and every index and .deb hash, so the
  mirror is untrusted. `Acquire::tabcomputer::Mirror` (apt.conf) or
  `$TABCOMPUTER_DEBIAN_MIRROR` point it elsewhere.
- **Index decompression.** apt's `store` method (it turns each downloaded
  `Packages.xz` into `Packages` and hashes it) is diverted the same way to
  `#!/usr/bin/shiro-apt-store` (`src/debian/apt-store.ts`): the xz/gz/bz2/
  zstd codecs and hashes run in the page. Under the x86 engine the original
  spent ~33 s of a ~72 s `apt-get update` decoding trixie's 56 MB index.
  apt checks the result's hashes against the signed Release file as before;
  `tabcomputer-alternatives --set /usr/lib/apt/methods/store debian` restores it.

### Package mirror: what the operator hosts

`server.mjs` serves `/debian/mirror/<host>/<path>`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `TABCOMPUTER_DEBIAN_MIRRORS` | `deb.debian.org=https://deb.debian.org,security.debian.org=https://security.debian.org` | archive host names apt uses → upstream base URL. Only these hosts and only `…/dists/…` and `…/pool/…` paths are served (not an open proxy). Point a host at a local mirror or `https://snapshot.debian.org/archive/debian/<ts>` to pin. |
| `TABCOMPUTER_DEBIAN_CACHE` | `$TMPDIR/shiro-debian` | disk cache (`TABCOMPUTER_DEB_CACHE` is the old name). `pool/` and `by-hash/` files are immutable and kept forever; other index files for `TABCOMPUTER_DEBIAN_INDEX_TTL` seconds (600). |
| `TABCOMPUTER_DEBIAN_SNAPSHOT` | `https://snapshot.debian.org/archive/debian/20260712T000000Z/` | where a `deb.debian.org` pool file the mirror no longer has (removed by a point release) is fetched from instead |

The GUI apps (src/gui/apps.ts, docs/GUI.md) fetch their pinned .debs as
`/debian/pool/PATH`, which is the same mirror (`/debian/mirror/deb.debian.org/debian/pool/PATH`)
and the same cache; they check each file's sha256 themselves.

Responses are same-origin, so no CORS or COEP issues. Traffic per user is
what apt fetches: `apt update` is ≈10 MB (trixie's Packages.xz, plus the
small updates/security indexes; translations are off), and each install is
its .debs. nginx needs no change. An operator who prefers a static mirror
can serve a Debian mirror tree (debmirror/aptly) under `/debian/mirror/`
with the same `<host>/<path>` layout.

## 3. Hybrid overlay

Which implementation runs is recorded in dpkg's own database, as local
diversions, so apt and dpkg stay truthful (`src/debian/overlay.ts`):

- **tabcomputer's**: `dpkg-divert --local --rename --divert PATH.debian --add PATH`.
  Debian's file lives at `PATH.debian` (upgrades land there too); `PATH`
  holds a builtin shim (`#!/usr/libexec/tabcomputer/builtin`), which the
  kernel and the shell run as the tabcomputer command of that name. The file
  is there for programs that search PATH themselves with stat(): Debian's
  bash running a `curl … | bash` installer found no `grep` without it.
  Programs whose tabcomputer side is a kernel program (apt, apt's methods)
  get a `#!/usr/bin/<command>` stub instead. Builtins Debian doesn't ship
  (curl, git, rg, …) get the same shim in `/usr/bin` while no file provides
  them; a package that installs the real program replaces it.
  Neither kind counts as a Debian program shadowing the builtin.
- **Debian's**: no diversion; `PATH` is the package's own file, and in
  Debian mode a program file in `/usr/{local/,}{s,}bin` takes precedence
  over a tabcomputer builtin of the same name (`debianShadows`, kept current as
  dpkg adds and removes files).

`dpkg-divert --list`, `dpkg -S /usr/bin/grep` and `dpkg --verify` show what
runs. Switching is `update-alternatives` style:

```
tabcomputer-alternatives --list                 # every overlay-able program: who runs it, auto/manual, default
tabcomputer-alternatives --display grep
tabcomputer-alternatives --set grep debian      # manual choice; defaults never undo it
tabcomputer-alternatives --auto grep            # back to the default policy
tabcomputer-alternatives --auto all             # apply defaults (also run after installs)
```

Defaults are in `src/debian/overlay-policy.json`, one entry per program with
the reason. A program defaults to tabcomputer's only where tabcomputer's implementation
passes the same tests as Debian's (see the overlay tests); everything else is
Debian's.

## 4. Toolchain layers

`toolchain install c` installs a whole Debian toolchain in seconds instead of
apt's minutes. The packages are still Debian's, and dpkg knows them, so apt
keeps working afterwards:

```
toolchain list                   # the sets, their size, which are installed
toolchain install c              # build-essential, gdb, make, cmake, pkg-config
toolchain install python tex     # several at once; `debian install` runs first if needed
toolchain install java --check   # then run the set's smoke test
toolchain install c --apt        # the same packages through apt instead
```

| id | packages asked for | Debian packages | compressed |
| --- | --- | ---: | ---: |
| `c` | build-essential, gdb, make, cmake, pkg-config | 115 | 146 MB (419 MB unpacked) |
| `python` | python3, python3-pip, python3-venv, python3-dev, python3-setuptools, python3-wheel, python3-requests, python3-numpy, python3-yaml | 60 | 55 MB (173 MB unpacked) |
| `node` | nodejs, npm | 383 | 69 MB (242 MB unpacked) |
| `java` | default-jdk-headless | 11 | 156 MB (306 MB unpacked) |
| `classic` | gfortran, gnucobol, fp-compiler, fp-units-rtl, gnat | 61 | 142 MB (415 MB unpacked) |
| `tex` | texlive-latex-recommended, latexmk | 65 | 86 MB (235 MB unpacked) |
| `go` | golang-go, plus std compiled into the build cache | 4 | 116 MB (414 MB unpacked, 163 MB of it the cache) |

Sizes are from `.toolchain-build/layers/index.json` (build of 2026-10-09). Nothing is
downloaded at install time beyond the layer's index. A program's chunks are
fetched the first time it runs.

Sets added since that build, not built yet. These numbers are apt's own for
the base's snapshot (the `Packages` indexes of 20261001T000000Z resolved
without Recommends, as the base's apt does; the same sum gives 65, 60, 61 and
115 packages for `tex`, `python`, `classic` and `c`, which is what the built
layers have). Chunks are gzip, so a layer comes out 1.1 to 1.5 times its
`.deb`s:

| id | packages asked for | Debian packages | `.deb`s | unpacked |
| --- | --- | ---: | ---: | ---: |
| `rescue` | libwpd-tools, libmspub-tools, libwps-tools, libmwaw-tools, mdbtools, pandoc | 23 | 43 MB | 253 MB (194 MB of it pandoc) |
| `tex-full` | `tex`'s, and texlive-latex-extra, texlive-pictures, texlive-science, texlive-bibtex-extra, biber, texlive-plain-generic, texlive-fonts-recommended, texlive-fonts-extra, texlive-xetex, texlive-luatex | 222 (157 more than `tex`) | 1019 MB | 2.7 GB |

`tex-full` **extends** `tex`: the builder installs `tex`'s packages and then
its own, so the layer is a superset of `tex`'s (the packages they share are
the same chunks) and a tab applies it instead. `toolchain install tex` after
it says the set is already installed and leaves the files no package owns
alone (`tex`'s `ls-R`, formats and font maps would name less). When the
server has `tex` and not yet `tex-full`, `toolchain install tex-full` applies
`tex` and gets the rest with apt. Most of it is texlive-fonts-extra: 1.7 GB
unpacked and 103,808 of the roughly 150,000 files, against `tex`'s 8,939.
Without it the set would be 320 MB of `.deb`s on top of `tex`. It is in
because thesis templates name its fonts (fourier, in #111). The files
still download only when TeX opens them, but the index lists every path,
so expect `toolchain install tex-full` to take longer than the 1.5 s of
`tex`; that is not measured yet. A set can ask for free disk at build time
(`disk_gb`, 8 for `tex-full`): the builder skips it on a host with less,
and the tab uses apt.

`python` gains python3-tk (#112), which the layer built on 2026-10-09 does
not have: 23 more packages (Tcl/Tk, libX11, fontconfig, the DejaVu fonts),
7 MB of `.deb`s, 21 MB unpacked. With it `import turtle` works in Debian's
`python3` and draws in an X11 window on the desktop (`DISPLAY=:0`). The
built-in WebAssembly `python3` (`pkg`) still has no tkinter: there `import
tkinter` and `import turtle` fail with a line naming `toolchain install
python` (`src/python-hints.ts`). Installing the set makes `python3` Debian's,
which runs in the x86 emulator and is several times slower (#124: 0.40 s
against 3.3 s for a 2-million sieve); `toolchain list` and the install say
so, and the welcome card's Python is the built-in one.

`rescue` (#114) converts files no current program opens: `wpd2html` and
`wpd2text` (WordPerfect), `pub2xhtml` (Publisher), `wps2html`, `wks2csv`
(Works, Lotus 1-2-3), `mwaw2html` (ClarisWorks and other old Mac formats),
`mdb-tables`, `mdb-export`, `mdb-schema` (Access), and `pandoc` to turn the
HTML into DOCX, Markdown or EPUB. LibreOffice's headless converter
(`soffice --headless --convert-to pdf`) is not in it. By the same sum,
libreoffice-writer-nogui, -calc-nogui, -impress-nogui and -draw-nogui are
163 more packages, 122 MB of `.deb`s and 394 MB unpacked on top of `rescue`
(174 packages, 138 MB and 450 MB alone), four times the rest of the set,
and whether `soffice` starts under Blink has not been tried. If it does, it
belongs in a set of its own that extends `rescue`.

Not in `tex-full`: the LaTeX `svg` package runs Inkscape through `--shell-escape`
(`sudo apt-get install inkscape`, 133 more packages), and `minted` needs
`python3-pygments`.

`pip install NAME` works in Debian's python3 without a venv: tabcomputer writes
`/etc/pip.conf` with `break-system-packages = true` (`pipInstallsPackages` in
`src/debian/rootfs.ts`) when the file doesn't exist; edit or empty it to get
PEP 668's refusal back. gdb (installed with `c`) debugs a program through
the x86 engine's debug stub rather than ptrace: `gdb ./prog`, `break`, `run`,
`next`, `step`, `print`, `bt`, `watch`, Ctrl-C and a stop on a segfault work
for a program's main thread (docs/research/GDB.md says what doesn't).

**What a layer is.** `scripts/debian/build-layers.sh` (root, any Linux host)
rebuilds the exact base rootfs users install from `public/debian`
(`unpack-rootfs.mjs`) and chroots into it. It points apt at the base's
snapshot.debian.org timestamp (trixie, trixie-updates and trixie-security),
runs `apt-get install` for the set, restores the base's apt sources and the
overlay's stubs, and clamps times to `SOURCE_DATE_EPOCH`. `pack-layer.mjs`
then diffs the tree against the base and writes `OUT/<id>/layer.json` and an
index, plus `OUT/chunks/<sha256>.gz` and the catalog `OUT/index.json`. The
index holds:

- the packages that are new or changed, each with its dpkg status stanza;
- every new or changed path, with the package that owns it (from dpkg's
  `.list` files; dpkg's `info/` files count as their package's). Paths no
  package owns (alternatives, `ld.so.cache`, `__pycache__`, TeX's formats)
  are always applied;
- the text databases maintainer scripts edited, stored whole and merged
  entry by entry on apply: `/var/lib/apt/extended_states` (apt's
  auto-installed marks), debconf's `*.dat`, `/var/lib/dpkg/diversions`,
  `statoverride` and `triggers/*`, and `/etc/passwd`, `group`, `shadow`,
  `gshadow` and `shells`.

A layer ships with nothing left for dpkg to do. apt configures the packages
and runs their triggers in the chroot (tex-common's: every TeX format, the
`ls-R` files, updmap's font maps; `ldconfig`; fontconfig's and the MIME
caches where a set has them), and what they wrote is in the layer. After
apt and the set's `prepare`, the builder runs `dpkg --configure --pending`
and `dpkg --triggers-only --pending`, then fails the set if `dpkg --audit`
reports anything, a status stanza has `Triggers-Pending` or
`Triggers-Awaited`, or `triggers/Unincorp` isn't empty. `pack-layer.mjs`
refuses such a tree too (`toolchain-layers.test.ts`). Otherwise the user's
next `apt install` would do that work in the tab, under Blink (#109).

That does not make a later `apt install texlive-…` fast. Debian's TeX Live
packages whose postinst runs `update-texmf-config format` (texlive-latex-extra,
texlive-luatex, texlive-xetex, …) activate tex-common's `texmf-format`
trigger, and tex-common then rebuilds every format (`fmtutil --sys --all`),
about ten minutes in the tab. That is what #109 measured; the `tex` layer
had no trigger pending. The packages people reach for are therefore a layer
of their own, `tex-full`.

A set can also name `prepare` commands, which run in the chroot after apt
and are part of the recipe. `go` uses this to run `go build std` with
`HOME=/home/user` and `CGO_ENABLED=0`, so the layer carries the standard
library already compiled in the tab user's default build cache
(`~/.cache/go-build`, unowned files). The tab's `go` has the same GOROOT
and compiler. The layer also sets `CGO_ENABLED=0` and `GOFLAGS=-p=1` in `~/.config/go/env`,
the file `go env -w` writes; it is merged key by key, so a user's own
setting wins. Without that, `go` would find tabcomputer's `cc` (a WASM-only
compiler) on PATH, turn cgo on for `net` and fail. With it, `go build`
and `go run` hit the cache and compile only the user's packages.
One build job at a time costs nothing under Blink, which runs one guest thread at a time. It also avoids a Blink bug: its vfork emulation can take Go's preemption signal (SIGURG) during parallel forks and wedge `go`, leaving its other children as zombies (with perf-blink). `go env -u CGO_ENABLED` turns cgo back on, for example with the `c` set
installed; the cgo packages then compile once.

`classic` uses `prepare` for a Debian bug (#110). trixie has one libxml2,
version `2.12.7+dfsg+really2.9.14`: the 2.9.14 library under a 2.12.7
version number. Debian's libcob4t64 3.2-3 was compiled while the archive
had the real 2.12.7 and was not rebuilt, so every program `cobc` builds
calls `xmlCheckVersion(21207)` at start and libxml2 prints "Warning: program
compiled against libxml 212 using older 209". The set's package list is not
at fault (apt on any trixie machine gives the same pair), and no package in
trixie fixes it. So the step changes the version libcob asks for, in
`libcob.so.4.2.0`, to the one installed (20914): four bytes, at the two
calls, and only when the library is that libxml2 and has exactly those two
calls. `dpkg --verify libcob4t64` reports the file as changed, and a
libcob4t64 from a later Debian update replaces it as usual. Checked on the
snapshot's own `.deb` (the two `mov $0x52d7,%edi` before `xmlCheckVersion`
become `$0x51b2`); a COBOL program has not been run against the patched
library yet.

Go deletes cache entries whose mtime is more than 5 days old (once a day,
recorded in `trim.txt`), and it ignores a `trim.txt` dated in the future.
The layer's times are the snapshot's, so the first `go` command used to trim
every shipped entry, and the next build compiled std again under Blink. The
cache entries are therefore dated 2100 (a `touch` in the set's `prepare`).
build-layers.sh clamps times after the snapshot, except ones beyond 2096, so
those stay. Go never trims or re-touches them. `go clean -cache` empties the
cache.

Chunks are the base rootfs's format (gzip, named by the sha256 of their
bytes). Each package gets its own chunks, so a package two sets share (gcc-14
in `c` and `classic`) is stored and fetched once.

**Applying** (`src/debian/layers.ts`, `toolchain` in `src/commands/toolchain.ts`)
works like dpkg, without running anything. A package is written when this
machine doesn't have it, or has an older version (dpkg's version
comparison). Otherwise it is kept as it is. Its paths become lazy
placeholders (`FSNode.lazy`, source = the layer id) in one batch, and a path
diverted on this machine lands where the diversion points. Its status stanza
replaces or joins dpkg's `status`, the merged databases gain the entries
they lack, and files an upgraded package no longer ships are removed.
`/var/lib/shiro/layers.json` records what was applied, and boot re-attaches
those layers' chunk loaders (`bootLayers`). The overlay's defaults run
afterwards, as after `debian install`. Then `apt install` of anything in the
layer says it is already the newest version, and other packages install on
top as usual (`toolchain-layers.test.ts`).

A layer is built on one base rootfs id and refuses others. When the server
has no layer for this machine's base, `toolchain install` uses apt instead,
and says so.

**Upgrades.** Layers are pinned to the base's snapshot, like the base
itself. `sudo apt update && sudo apt upgrade` brings their packages up to
the archive's current versions, as on any Debian system. To move layers to
a new snapshot, rebuild the base (`build-rootfs.sh` with a new `SNAPSHOT`)
and then the layers. `build-layers.sh` rebuilds a set only when its recipe
changes. The recipe is the hash of the base id, the snapshot, the package list
and the builder scripts; `FORCE=1` rebuilds anyway. Each set keeps its
current index and the one before it, because machines that applied the
older layer still fetch its chunks. With `PRUNE=1`, chunks that neither
names are deleted.

**Serving.** `server.mjs` serves `TABCOMPUTER_DEBIAN_LAYERS` (a directory) at
`/debian/layers/`. Chunks and indexes are served immutable and the catalog
`no-cache`. Unset, `/debian/layers/` is whatever `STATIC_DIR` has there. Layers
are never committed (about 650 MB of chunks for all six sets). On
tabcomputer.com, `deploy/tabcomputer/release.sh` starts the builder in the
background after each deploy (systemd unit `tabcomputer-layers`: nice 19,
idle I/O, `CPUQuota=50%`, `PRUNE=1`) with `OUT=/opt/tabcomputer/layers`,
which `server.env` serves. It never fails or delays the deploy, and it
refuses to start with less than 6 GB free (`MIN_FREE_GB`). The
first build fetches the packages from snapshot.debian.org. Later deploys
rebuild only sets whose recipe changed (every set, when `build-layers.sh` or
`pack-layer.mjs` changed). Downloaded `.deb`s stay in
`/opt/tabcomputer/layer-build/debs` for rebuilds. Until a set is built,
`toolchain install` falls back to apt. Locally:

```
sudo bash scripts/debian/build-layers.sh            # all sets → .toolchain-build/layers
sudo bash scripts/debian/build-layers.sh c python   # some
TABCOMPUTER_DEBIAN_LAYERS=$PWD/.toolchain-build/layers PORT=5299 STATIC_DIR=$PWD/dist node server.mjs
```

The builder runs in its own mount namespace with every mount private. It
mounts a fresh sysfs and one-level binds of `/dev`, `/dev/pts` and
`/dev/shm` (never `--rbind`), and it fails if the caller's or PID 1's mount
table changed during the build. An earlier version rbind-mounted `/sys` and
`/dev` and unmounted them with `umount -l`. On a systemd host (shared
propagation) that unmounted the host's own `/sys/fs/cgroup`, and systemd
could start no unit afterwards. `scripts/debian/check-layer-mounts.sh`
reproduces that setting: it runs a one-package build in a namespace with
shared propagation and fails if the mount table changes. Run it after
changing the builder; it caught the old version.

Behind a TLS-intercepting proxy, pass its CA as `CA_BUNDLE=...`
(`HTTPS_PROXY` is passed on to apt).

**Measured:** BENCHMARKS.md "Toolchain layers" (`node bench/run.mjs --suites
toolchains`).

## Known gaps

- systemd's postinst (systemd-sysusers, pulled in by cron, udev, logrotate)
  fails with "Failed to backup /etc/group: Bad address": Blink's `sendfile`
  rejects a NULL offset (reported to unix/perf-blink).
- `open(dir, O_TMPFILE)` fails (EISDIR); programs that try it fall back to a
  named temporary file.
- One guest thread runs at a time (Blink's GIL); apt and dpkg are
  interpreted/JIT-compiled x86. `apt-get update` takes about 45 s
  (BENCHMARKS.md "Real workloads": 43 s), installing a small package about a minute.
- dpkg-deb's `.xz` decompression occasionally crashes or reports corrupt data
  under Blink (X86_ENGINES.md item 57); rerunning the install gets past it.
- How Debian packages coexist with `pkg`'s prebuilt ones (who owns `/usr/bin/NAME`,
  switching back and forth): README.md, "How prebuilt, Debian and built-in commands coexist".
