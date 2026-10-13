# Package layers: where apt's minute goes, and what replaces it

2026-10-13. Issue #135. What was built is described in
[DEBIAN.md](../DEBIAN.md) "Package layers"; this is the study behind it.

## The problem

A one-file app names Debian packages in `needs`. A person who opens the
app's link waits for `apt` under the x86 emulator. Measured on production
(#135, Build 1014 and 1016, fresh profile, Apple M3):

| | time |
| --- | ---: |
| `apt install -y tesseract-ocr` | 65 s |
| `apt install -y qpdf ghostscript poppler-utils genisoimage pandoc` | 81 s |
| `?app=searchable-pdf` with `needs: ["ocrmypdf"]`, link to usable page | 527 s |
| `toolchain install c` (115 packages, a prebuilt layer) | 0.8 s |
| OCR of one page (`tesseract page.png out pdf`) | 2.9 s |

The job takes seconds. The install is the wait.

## Where the 65 s go

Measured on this machine: an Apple M3 with 8 GB, headless Chrome, a local
`server.mjs` in front of deb.debian.org, a build of main (Build 1016's
`dist`; the apt path and the Debian base are the same in 1018). The same
command as on production, in one go, twice: **66.4 s** and **67.2 s**
(`tests/browser/capture-layer.mjs` prints it). So this machine and
production agree, and the network is not what differs.

Then the same install in steps, each timed in the page, with the requests
to `/debian/` counted from the browser's resource timings and dpkg's own
log (`/var/log/dpkg.log`) for the phases inside dpkg:

| step | time | of which network | what it is |
| --- | ---: | ---: | --- |
| `debian install` | 0.2 s | 0.1 s | paths as placeholders |
| `apt-get update` | 12.0 s | 3.6 s | 10 MB of lists, and 13 MB of the base's own chunks (apt, its libraries) read for the first time; the rest is apt building its cache from 58 MB of `Packages` under the emulator |
| `apt-get install --download-only` | 5.3 s | 2.6 s | 71 `.deb`s, 33.1 MB; the rest is apt starting and resolving |
| `apt-get install -s` (resolve only) | 5.1 s | 0 | apt starting, reading its cache, planning: paid by every apt run |
| `apt-get install`, archives present | 38.8 s | 0.1 s | of which, from dpkg's log: |
| … apt before dpkg starts | 3.8 s | | |
| … `dpkg --unpack`, 71 packages | 27 s | | 0.38 s a package |
| … `dpkg --configure`, 71 packages | 7 s | | maintainer scripts; fontconfig's regenerates the font cache |
| … triggers (`ldconfig`) | 1 s | | |

Run as steps the install is 56 s; as one command it is 66 s (the guard in
front of apt adds a check and one more apt start).

By kind of work:

| | time | share of 56 s |
| --- | ---: | ---: |
| dpkg unpacking under the emulator | 27 s | 48% |
| package lists (fetch, decode, apt's cache) | 12 s | 21% |
| apt starting and planning (two starts) | 9 s | 16% |
| maintainer scripts and triggers | 8 s | 14% |
| downloading the `.deb`s | 2.6 s | 5% |

Three things follow.

1. **The network is 5 to 10% of it.** A faster mirror would not be noticed.
2. **Unpacking is half, and none of it is needed in the tab.** A file's bytes
   are the same wherever dpkg unpacks them.
3. **Maintainer scripts are 8 s, and they read files.** `ldconfig` opens every
   library and fontconfig's cache reads every font. In a tab whose files are
   placeholders, running them fetches most of the set at once.

## Two designs

**A. A layer per set, built on the server.** apt and dpkg run natively in a
chroot of the base, as `build-layers.sh` does for the fixed toolchain sets.
The tab gets paths, dpkg's records and what the maintainer scripts wrote.
Nothing runs in the tab.

**B. A prebuilt tree per package, put together in the tab.** The server
turns each `.deb` into chunks once (no root, no chroot, no script run). The
tab resolves or is told the dependencies, writes the paths and marks the
packages unpacked, then runs `dpkg --configure` under the emulator.

| | A: layer per set | B: tree per package |
| --- | --- | --- |
| time in the tab, tesseract-ocr | under 1 s to apply | 1 s to apply, then 8 s of scripts and triggers, which also fetch the libraries and fonts they read |
| link to a finished OCR (job 3 s) | about 5 s | 12 s or more: over the 10 s target |
| python packages, TeX | as fast as any set | byte-compiling and format building under the emulator: minutes (#109 measured ten for TeX) |
| first request ever | a build: tens of seconds to minutes | a conversion: seconds |
| storage shared between sets | yes: chunks are per package and named by content | yes |
| the server runs | Debian's maintainer scripts, as root in a chroot | nothing |
| correctness | what apt produces | dpkg's unpack done by hand (conffiles, triggers, diversions): a second implementation of dpkg |

B is safer on the server and quicker the first time. A is the only one that
reaches the target every later time, because the 8 s of scripts and what
they read stay in the tab under B. The first request is the rare case; the
sets people open through shared links are built at deploy. So: **A**, with
the server's exposure handled by limits (below), and the first build's wait
shown as it happens.

## What was built

See DEBIAN.md "Package layers". In short:

- `GET /debian/layers/set?base=ID&packages=a,b` in `server.mjs` answers
  `ready` with the layer, `queued` or `building` with the phase and "N of
  M", or `failed`/`unavailable` with a reason.
- The key is the base rootfs id, its snapshot and the sorted names.
- `scripts/debian/build-set.sh` builds one set. It is a copy of
  `build-layers.sh`'s core with limits in front, and a script of its own:
  the toolchain recipe is a hash of `build-layers.sh` and `pack-layer.mjs`,
  so changing either would rebuild every toolchain layer on the droplet,
  hours of work at half a CPU, for no change in them.
- The tab applies a `ready` layer with the code `toolchain install` uses,
  then fetches the set's chunks in the background.
- `needs`, `apt install` in both modes, and `toolchain install NAME` go
  through it. #136 is fixed on the way.

## Safety and cost on the server

The droplet has 1 vCPU, 2 GB of RAM and one disk shared with the releases,
the toolchain layers (about 650 MB), the Claude and Pyodide caches and a
2 GB swap file. `server.mjs` runs as root there, so it can start the
builder itself.

| limit | value | where |
| --- | --- | --- |
| a name | Debian's grammar for package names, 2 to 63 characters | `PACKAGE_NAME` |
| names in a request | 12 | `TABCOMPUTER_LAYER_SET_MAX_NAMES` |
| kinds never built | kernels, boot loaders, init, udev, kernel modules, storage and container managers, firmware; by requested name and by everything the set would install | `PACKAGE_REFUSED`, `set-limits.mjs` |
| the archive | trixie, trixie-updates, trixie-security at the base's snapshot, component main; every URL apt plans must be under `pool/main/` | `build-set.sh`, `set-limits.mjs` |
| a set's size | 400 packages, 200 MB of `.deb`s, from apt's plan, before any download | `set-limits.mjs` |
| a build | 15 minutes, 900 MB of memory, half a CPU, nice 19, idle I/O, its own mounts and no host devices | `packageBuildCommand` |
| builds at once | 1; 8 waiting | `createPackageLayers` |
| one address | 2 builds waiting or running; 6 started in an hour | `createPackageLayers` |
| a failed build | not started again for 10 minutes | `createPackageLayers` |
| all sets on disk | 3072 MB of chunks; least recently used go first; the sets built at deploy stay | `set-evict.mjs` |
| free disk to start a build | 3 GB | `build-set.sh` |

What a request supplies is a list of names that passed the grammar. It goes
into a JSON file; the builder reads the file and checks each name again
before it gives them to apt as separate arguments. The builder's command
line carries the set's key (hex digits) and nothing else. What runs as root
is apt, dpkg and the maintainer scripts of the Debian packages in the set,
which is what the toolchain builder has always run for the fixed sets. The
difference is who picks the packages, and that is what the refusal list,
the main-only check and `PrivateDevices` are for.

**Disk a layer takes.** tesseract-ocr: 71 packages, 99 MB unpacked, **40 MB**
of chunks (measured on the captured layer). By apt's index for the same
snapshot, without Recommends:

| set | packages | `.deb`s | unpacked |
| --- | ---: | ---: | ---: |
| genisoimage | 3 | 0.8 MB | 12 MB |
| imagemagick | 45 | 15 MB | 45 MB |
| pandoc | 6 | 27 MB | 200 MB |
| tesseract-ocr | 71 | 33 MB | 106 MB |
| ghostscript, poppler-utils, qpdf | 98 | 40 MB | 122 MB |
| ocrmypdf | 146 | 67 MB | 230 MB |
| ffmpeg | 207 | 133 MB | 467 MB |

Chunks are gzip and the `.deb`s are xz, so a layer is about 1.2 times its
`.deb`s (tesseract-ocr: 40 MB against 33 MB). The five sets built at deploy
are 116 MB of `.deb`s, about 150 MB of chunks, less what they share. A cap
of 3 GB holds on the order of sixty sets of tesseract-ocr's size. ffmpeg is
not built at deploy: it is over three times the next largest, and the tab
has an ffmpeg of its own. It is under the request limit, so a tab can still
ask for it.

**What the first request costs.** Not measured: the builder needs root and a
Linux chroot, and this study was done on a Mac. From its parts on the
droplet (half a CPU): a copy of the base, apt's cache from the kept lists,
33 MB from snapshot.debian.org, a native unpack and configure, and gzip of
100 MB. Expect about a minute for tesseract-ocr, more for a first build
that also fetches the lists. That is no faster than apt in the tab for the
first person. It is the price of one second for everyone after.

## Results

`node tests/browser/package-layers.mjs --layers DIR`, headless Chrome on the
same Apple M3, one build of this branch, a fresh profile for each line. The
layers are real ones for tesseract-ocr (71 packages, 40 MB of chunks) and
genisoimage (3 packages, 1.2 MB), made by `tests/browser/capture-layer.mjs`.
The page is a made-up scan: A4 at 150 dots an inch, 30 lines of text.

| | apt in the tab | the set's layer |
| --- | ---: | ---: |
| `?app=searchable-pdf`, link to usable page | 70.7 s | **0.9 s** |
| the same, a second visit | | 0.1 s |
| the same over 50 Mbit/s with 40 ms of latency | | 2.3 s |
| link to a finished PDF of one page | 81.7 s | 15.6 s |
| of which tesseract on the page | 11.0 s | 14.6 s (12.8 s for the same page again) |
| the same over 50 Mbit/s and 40 ms: tesseract on the first page | | 23.1 s |
| `apt install -y tree tesseract-ocr` before Debian mode | 66 to 67 s for tesseract-ocr alone | **0.3 s** |
| `apt install -y genisoimage` in Debian mode | 15.7 s (the package lists are fetched first) | under 0.1 s |
| first run of `tesseract --version` after the install | | 1.1 s |

The target was under 10 s from the link to a usable page. It is 0.9 s
here, and 2.3 s on a line like a visitor's.

What is left is the job. tesseract takes 11 to 15 s for this page however
it was installed (the machine was running another agent's benchmark at the
same time, so these move by a few seconds). The first job after a layer
install also fetches what the program reads: on the local server that adds
about 2 s; at 50 Mbit/s it adds about 10 s, because tesseract's libraries
are most of the layer's 40 MB. Smaller chunks or a better compressor than
gzip would cut that; neither was tried.

A first-ever build, with a stand-in builder that reports as the real one
does (about 9 s) and then puts the real layer in place: the placeholder
showed "The server is preparing tesseract-ocr for the first time.", "The
server is downloading package N of 71 for tesseract-ocr.", "The server is
installing package 2 of 71 …" up to "68 of 71", "The server is packing
tesseract-ocr.", each followed by "This build happens once: the next person
gets these programs in seconds." The page was usable 11.0 s after the
link. The next visitor's was usable after 0.8 s.

With no layer and no builder the placeholder said "No ready-made copy of
tesseract-ocr (this server keeps none): apt installs it here, which takes a
few minutes.", and apt did.

## Found on the way: tesseract reads the page wrongly

The layer's tesseract and apt's print the same text for the page, byte for
byte. Both are mostly wrong. The page repeats four sentences ("tabcomputer
makes scans searchable", ...). One of the four appears somewhere in the 140
characters tesseract prints; the rest are lines like `2 _`, `, _`, `| 3`,
and a two-line image gives `Te ik wontons`. It warns "Image too small to
scale!! (2x36 vs min width of 3)" and "Line cannot be recognized!!". The
files are right:
every file of the 71 packages matches dpkg's md5sums. `-c
dotproduct=generic`, `--psm 6` and `--psm 7`, PNG or JPEG, 150 or 300 dots
an inch make no difference. So the fault is not in how the package was
installed. It is most likely in what the x86 emulator computes for
tesseract or leptonica; that was not confirmed, because no tesseract on
real hardware was at hand to read the same image. If production behaves as
this build does, the searchable-pdf example makes PDFs whose hidden text is
mostly nonsense. That was not fixed in this work. It needs someone on the
engine.

## What was not run

- `scripts/debian/build-set.sh` and `build-deploy.sh` were never run: they
  need root, a chroot and systemd on Linux, and this machine is a Mac with
  no container or virtual machine. They parse (`bash -n`), and
  `build-set.sh` is `build-layers.sh`'s proven steps in the same order. The
  first run is the deploy.
- So the `systemd-run` properties of a requested build (`PrivateDevices`,
  `MemoryMax`, `RuntimeMaxSec`) are untested with this script.
- The time of a first-ever build on the droplet.
- The layer used in the browser was made by `tests/browser/capture-layer.mjs`:
  Debian's own apt and dpkg installed tesseract-ocr in a headless tab, and
  `pack-layer.mjs` packed what changed. It is a real layer of the real
  packages, from deb.debian.org's current trixie and not the snapshot. A
  chroot build differs in where the maintainer scripts ran.
- Everything on the server that is not the build itself ran in vitest with a
  stand-in builder: the route, the key, the grammar and the refusal list,
  the queue and the limits per address, failures, the limits on a set's
  size, the disk cap.

If the builder fails on the droplet, nothing else changes: the server
answers `failed`, the tab says one sentence and uses apt, and toolchain
layers are built by the script they were always built by.
