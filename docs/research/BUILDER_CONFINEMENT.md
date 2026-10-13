# Confining the package set builder: a proposal

2026-10-13. Not applied. Nothing in this document has been run: the builder
needs root, systemd and a Linux host, and a mistake in its unit stops every
layer build on the droplet. This is the list of changes and the way to try
them there first.

The builder is described in [DEBIAN.md](../DEBIAN.md) "Package layers" and
[PACKAGE_LAYERS.md](PACKAGE_LAYERS.md). In short: `server.mjs` starts
`scripts/debian/build-set.sh KEY` as a transient systemd unit
(`packageBuildCommand`). The script unpacks the Debian base into a chroot,
lets apt install the set's packages there (which runs those packages'
maintainer scripts as root in the chroot), and packs what changed into a
layer.

## What the unit has today

```
systemd-run --unit=tabcomputer-set-KEY --wait --pipe --collect --quiet
  -p PrivateMounts=yes -p PrivateDevices=yes
  -p Nice=19 -p IOSchedulingClass=idle -p CPUQuota=50%
  -p MemoryMax=900M -p RuntimeMaxSec=900
  -E BASE=… -E OUT=… -E WORK=… -E SPEC=… -E TC_SET_…=…
  bash /opt/tabcomputer/set-build/tools/build-set.sh KEY
```

The script adds a mount namespace of its own (`unshare --mount --propagation
private`) and checks that the host's mount table is unchanged afterwards.

That bounds time, memory, CPU and mounts. It does not bound what the build can
read and write on the host's filesystem outside the chroot, which processes it
can see, when it has the network, or which capabilities it holds. Two
directories are shared by every build: the downloaded `.deb`s (`WORK/debs`)
and apt's lists (`WORK/lists/SNAPSHOT`).

## The aim

A build:

1. writes only under its work directory and the sets directory;
2. sees only its own processes;
3. has the network while apt resolves and downloads, and not while packages
   are installed;
4. holds, while packages are installed, only the capabilities dpkg and
   maintainer scripts use;
5. installs from files that no earlier build could have changed.

## Unit properties

Added to the `-p` list in `packageBuildCommand` (server.mjs), in this order
of confidence. Paths are the production ones; `cfg.work` and `cfg.dir` give
them.

| Property | Why | What could break |
| --- | --- | --- |
| `ProtectSystem=strict` | The whole file system is read-only to the unit. | Anything the script writes outside the two paths below. Today: nothing known. |
| `ReadWritePaths=/opt/tabcomputer/set-build /opt/tabcomputer/layers/sets` | The work directory (the chroot, the `.deb`s, the lists, the lock) and the output. | A changed `TABCOMPUTER_LAYER_BUILDER_WORK` or `TABCOMPUTER_DEBIAN_LAYERS` must change this too: build it from `cfg`. |
| `ProtectHome=yes` | `/root`, `/home`, `/run/user` are not there. | Nothing known. The chroot has its own `/root`. |
| `PrivateTmp=yes` | Its own `/tmp` and `/var/tmp`. | Nothing known: the script uses `WORK`, not `/tmp`. |
| `InaccessiblePaths=-/etc/tabcomputer -/opt/tabcomputer/seeds -/opt/tabcomputer/pyodide -/opt/tabcomputer/debian-cache` | Paths the build has no use for. `-` means "if it exists". | Nothing known. |
| `ProtectKernelModules=yes` `ProtectKernelLogs=yes` `ProtectClock=yes` `ProtectHostname=yes` | The build loads no module, reads no kernel log, sets no clock and no host name. | Nothing known. |
| `ProtectControlGroups=yes` | cgroups read-only. | Nothing known. |
| `ProtectKernelTunables=yes` | `/proc/sys`, `/sys` read-only in the unit. | The script mounts a fresh `proc` and `sysfs` inside the chroot; this property does not cover those (see "Script changes"). |
| `NoNewPrivileges=yes` | No program gains privileges by being set-user-ID or by file capabilities. The build is root already. | apt drops to the `_apt` user to download; dropping is allowed. A maintainer script that runs `su` to a system user still works (root may change user). |
| `RestrictNamespaces=mnt pid net` | Only the namespaces the script makes itself. | A package whose maintainer script makes a user namespace. None known in the sets built so far. |
| `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK` | apt, DNS, and local sockets. | A maintainer script that opens another kind of socket. None known. |
| `RestrictRealtime=yes` `LockPersonality=yes` `SystemCallArchitectures=native` | None of these is used. | Nothing known. |
| `SystemCallFilter=~@clock @cpu-emulation @debug @module @obsolete @raw-io @reboot @swap` | A deny list: the groups a package install has no use for. | `@debug` holds `ptrace`: a maintainer script that runs `strace` or `gdb`. None known. |
| `CapabilityBoundingSet=CAP_SYS_ADMIN CAP_SYS_CHROOT CAP_NET_ADMIN CAP_SETPCAP CAP_CHOWN CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH CAP_FOWNER CAP_FSETID CAP_SETUID CAP_SETGID CAP_SETFCAP CAP_KILL` | The script mounts and chroots (`SYS_ADMIN`, `SYS_CHROOT`), brings `lo` up in its own network namespace (`NET_ADMIN`) and lowers the set for the install (`SETPCAP`); dpkg and apt need the rest. | A package that sets a capability on a file needs `SETFCAP` (kept). One that makes a device node needs `MKNOD` (already gone with `PrivateDevices=yes`). |
| `KeyringMode=private` `UMask=0022` | Housekeeping. | Nothing. |

Left out on purpose:

- `RestrictSUIDSGID=yes`: dpkg installs set-user-ID and set-group-ID files
  (`passwd`, `dbus-daemon-launch-helper`). With it, those installs fail.
- `MemoryDenyWriteExecute=yes`: some maintainer scripts run programs that
  compile at run time (the JDK's `java` in `ca-certificates-java`).
- `PrivateNetwork=yes` on the unit: apt needs the archive. The install phase
  loses the network in the script instead (below).
- `PrivatePIDs=yes`: it needs systemd 257. Check `systemd --version` on the
  droplet; with an older one the script makes the namespace (below), which
  works on both.
- `DynamicUser=` / `User=`: the build has to be root to chroot and to own the
  files it packs.

## Script changes (`scripts/debian/build-set.sh`)

1. **A process namespace.** The script already runs itself again under
   `unshare --mount --propagation private`. Add `--pid --fork --kill-child`
   to that line. The `proc` it then mounts in the chroot shows the build's
   processes only, and a signal from inside reaches nothing else. `--fork` is
   needed for a new process namespace to have a first process; `--kill-child`
   ends the build when the outer script is ended (the time limit).

2. **`proc` and `sysfs` in the chroot.** Mount `sysfs` read-only
   (`mount -t sysfs -o ro,nosuid,nodev,noexec sysfs "$ROOT/sys"`). Mount `proc`
   with `nosuid,nodev,noexec`, then bind `"$ROOT/proc/sys"` onto itself and
   remount it read-only (`mount --bind`, then
   `mount -o remount,ro,bind "$ROOT/proc/sys"`). `umount_all` gets
   `proc/sys` before `proc`.

3. **Two phases, and the network only in the first.** Today `in_root` is used
   for everything. Make two:

   - `in_root` as now, for `apt-get update`, `apt-cache pkgnames`,
     `--print-uris` and `--download-only`. No maintainer script runs in any
     of these.
   - `in_root_install` for `apt-get install`, `ldconfig` and the three `dpkg`
     calls: the same command inside
     `unshare --net -- sh -c 'ip link set lo up && exec "$@"' sh …`
     so that only a loopback interface exists, and inside the chroot through
     `setpriv` (util-linux, in the base) with the capabilities lowered:

     ```
     chroot "$ROOT" /usr/bin/setpriv \
       --bounding-set=-all,+chown,+dac_override,+dac_read_search,+fowner,+fsetid,+setuid,+setgid,+setfcap,+kill \
       --inh-caps=-all \
       /usr/bin/env -i PATH=… HOME=/root LANG=C.UTF-8 DEBIAN_FRONTEND=noninteractive SOURCE_DATE_EPOCH=… "$@" 8>&-
     ```

     `ip` on the host comes from `iproute2`; `release.sh` or cloud-init has to
     make sure it is installed.

4. **The install reads files of its own.** Between the two phases:

   - Check each downloaded `.deb` against the `SHA256:` apt printed for it in
     `WORK/uris.txt` (the output of `--print-uris`, which `set-limits.mjs`
     already reads). A file that does not match is deleted and the build
     stops with `::tc:: refused failed …`; the next build downloads it again.
   - Copy the set's `.deb`s (the names in `uris.txt`) from `WORK/debs` into
     the chroot's own `var/cache/apt/archives`, then unmount the shared
     directory from the chroot. A copy, not a hard link: a hard link is the
     same file. This costs up to 200 MB of writes per build
     (`TC_SET_MAX_DEB_MB`), at idle priority.
   - Remount the lists read-only in the chroot
     (`mount -o remount,ro,bind "$ROOT/var/lib/apt/lists"`). To verify: that
     `apt-get install` works with read-only lists. If it does not, copy the
     lists into the chroot the same way (about 50 MB for a snapshot).

   After this, nothing a package's script does in the chroot reaches a file
   a later build reads.

5. **The lock.** `flock` on fd 8 stays in the outer script, outside the
   process namespace, as now.

`build-layers.sh` (the toolchain layers at deploy) is not changed by any of
this. Its sets have `prepare` commands (Go compiles its standard library),
so it gets the same treatment only after the set builder has run confined
for a while.

## Outside the unit

Two things the same review named that this proposal does not cover:

- **The tab trusts a layer's index as served.** Chunks are checked against
  their sha256; the index is not. `layer.json` could carry the index's
  sha256 (`pack-layer.mjs` writes it, `applyLayerInfo` checks it). This is
  small and can be tested in vitest (`toolchain-layers.test.ts`).
- **The server runs as root.** It needs root only to start the builder. A
  template unit (`tabcomputer-set@.service`) that a `tabcomputer` user may
  start through a polkit rule would let the server itself run without it.
  That is a separate change with its own risks (ports, the cache
  directories' owners, the deploy script).

## How to try it on the droplet

None of this needs a deploy. Everything below runs by hand over ssh, in
scratch directories, and leaves the real sets alone.

**0. Before.** `systemd --version`. `command -v setpriv ip unshare`. A copy of
the tools: `cp -a /opt/tabcomputer/set-build/tools /opt/tabcomputer/confine-test/tools`,
and edit the copy of `build-set.sh` there.

**1. The properties are accepted.** With the full `-p` list in a shell
variable `$P`:

```
systemd-run --wait --pipe --collect $P true
```

A property this systemd does not know fails here, by name, in a second.

**2. What the unit can reach.** A probe in place of the build, with the same
properties, that tries each thing and prints one line per result:

```
systemd-run --wait --pipe --collect $P bash -c '
  for p in /etc/x /opt/tabcomputer/current/x /root/x /usr/local/bin/x; do
    if touch "$p" 2>/dev/null; then echo "WROTE $p"; rm -f "$p"; else echo "ok: cannot write $p"; fi
  done
  ls /etc/tabcomputer >/dev/null 2>&1 && echo "READ /etc/tabcomputer" || echo "ok: cannot read /etc/tabcomputer"
  touch /opt/tabcomputer/set-build/.probe && echo "ok: can write the work directory" && rm /opt/tabcomputer/set-build/.probe
'
```

Every line should start with `ok`. `systemd-analyze security` on a unit that
is held open (`sleep 300` as the command) gives a score to compare before
and after.

**3. A build, by hand, into a scratch directory.** Three sets that exercise
different things:

| Set | What it exercises |
| --- | --- |
| `tesseract-ocr` | The plain case: about 70 packages, nothing unusual. |
| `default-jdk-headless` | A maintainer script that runs `java`, and triggers. |
| `dbus iputils-ping` | A system user and group, a set-user-ID helper, a file capability. |

For each, with a spec file written by `set-key.mjs`:

```
key=$(node tools/set-key.mjs key /opt/tabcomputer/current/public/debian tesseract-ocr)
# (write /opt/tabcomputer/confine-test/specs/$key.json as server.mjs does)
systemd-run --unit=confine-test-$key --wait --pipe --collect $P \
  -p ReadWritePaths="/opt/tabcomputer/confine-test" \
  -E BASE=/opt/tabcomputer/current/public/debian \
  -E OUT=/opt/tabcomputer/confine-test/sets -E WORK=/opt/tabcomputer/confine-test/work \
  -E SPEC=/opt/tabcomputer/confine-test/specs/$key.json \
  bash /opt/tabcomputer/confine-test/tools/build-set.sh $key
```

Then the same set with the unchanged tools and today's properties, into a
second scratch directory. The two layers should hold the same files: compare
the lists of paths, modes, owners and sizes in the two indexes
(`gunzip -c sets/$key/index-*.json.gz`). If the builds are byte-for-byte
reproducible the two `layer.json` ids are equal, which is the whole check in
one line; if they are not, the differences should be only times.

**4. Inside the install phase.** Temporarily add a line to the scratch
`build-set.sh` after the packages are installed, run through
`in_root_install`:

```
in_root_install sh -c 'ls /proc | grep -c "^[0-9]"; cat /proc/net/dev | wc -l; mount -t tmpfs none /mnt 2>&1 | head -1; touch /var/cache/apt/archives/x 2>&1 | head -1'
```

Expected: a small number of processes (the build's own), three lines of
`/proc/net/dev` (two headers and `lo`), "permission denied" from `mount`, and
the `touch` succeeding only on the chroot's own archive directory (check that
`WORK/debs/x` does not exist).

**5. The host afterwards.** The script's own check of the mount table
passed (it exits 3 otherwise). `systemctl is-system-running` says `running`.
`systemd-cgls | grep confine-test` shows nothing. `findmnt | grep confine-test`
shows nothing.

**6. Time.** Compare the build times of step 3. The copy of the `.deb`s and
the hash check add I/O; the time limit is 900 s
(`TABCOMPUTER_LAYER_BUILD_SECONDS`) and the JDK set is the slow one.

**7. Turning it on.** Put the properties in `packageBuildCommand` behind
`TABCOMPUTER_LAYER_BUILDER_CONFINE=1`, set in
`profiles/tabcomputer/server.env`, so that one edited line and a restart of
the service undo it on the droplet without a new release. After the deploy,
ask for a set no one has built (`/debian/layers/set?base=…&packages=…`) and
watch `journalctl -u tabcomputer -g '\[layers\]'`: one `building` line and one
`built` line. A failure is not an outage: the tab is told `failed` and
installs with apt, as it does today when a build fails.

`package-layers.test.ts` checks the `-p` list `packageBuildCommand` makes;
it needs the new properties added when they go in.
