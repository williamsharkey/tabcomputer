#!/usr/bin/env bash
# Build the layer of one package set (docs/DEBIAN.md "Package layers"): the
# Debian packages a tab asked for (server.mjs starts this) or a set built
# ahead (build-deploy.sh). It is build-layers.sh for one set whose packages
# come from a request: the same chroot of the base users install, the same
# pinned snapshot, the same packer (pack-layer.mjs), with limits in front.
# build-layers.sh is not changed by it, so toolchain layers build as before.
#
#   sudo SPEC=FILE bash scripts/debian/build-set.sh KEY
#
# SPEC is a JSON file { "layers": { KEY: { "packages": [...] } } }; the names
# never come from the command line. Environment:
#   BASE      packed base rootfs (default public/debian)
#   OUT       the sets directory (TABCOMPUTER_DEBIAN_LAYERS/sets)
#   WORK      scratch directory, shared by every set build (one at a time)
#   SNAPSHOT  snapshot.debian.org timestamp (default: the base's)
#   MIRROR    archive URL prefix (default https://snapshot.debian.org/archive)
#   FORCE=1   rebuild a set whose recipe is unchanged
#   MIN_FREE_GB           refuse to start with less free disk on WORK (default 3)
#   TC_SET_MAX_PACKAGES   what the set may install, dependencies included (set-limits.mjs)
#   TC_SET_MAX_DEB_MB     their .debs together
#   TC_SET_REFUSE         a regular expression of package names never built on request
#   TC_SETS_MAX_MB        chunks of all sets on disk; the sets used longest ago are
#                         removed first (set-evict.mjs), default 3072
#   TC_SET_PIN=1          mark this set as never removed (the sets built at deploy)
#   CA_BUNDLE, HTTPS_PROXY  as for build-layers.sh
#
# Lines that start "::tc::" tell server.mjs how far the build is:
#   ::tc:: waiting                    another build holds the lock
#   ::tc:: phase resolving|downloading|installing|packing
#   ::tc:: total N                    packages the set installs
#   ::tc:: refused REASON SENTENCE    over a limit; exit 4, nothing was installed
# apt's own "Get:" and "Setting up" lines count the packages in between.
#
# What runs as root here: apt and dpkg from the base, and the maintainer
# scripts of the Debian packages the set installs, inside the chroot. Nothing
# a request carries is run or read as shell text. Needs root (chroot, mounts),
# node, flock, and a Linux host.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
BASE="${BASE:-$REPO/public/debian}"
OUT="${OUT:-$REPO/.toolchain-build/layers/sets}"
WORK="${WORK:-$REPO/.toolchain-build/sets}"
SNAPSHOT="${SNAPSHOT:-$(node -p 'require(process.argv[1]).snapshot' "$BASE/rootfs.json")}"
MIRROR="${MIRROR:-https://snapshot.debian.org/archive}"
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1790812800}"

[ "$(id -u)" = 0 ] || { echo "build-set.sh: run as root (it chroots)" >&2; exit 1; }
id="${1:-}"
[[ "$id" =~ ^p-[0-9a-f]{24}$ ]] || { echo "build-set.sh: usage: SPEC=FILE build-set.sh KEY (p- and 24 hex digits)" >&2; exit 2; }
[ -f "${SPEC:-}" ] || { echo "build-set.sh: SPEC names no file" >&2; exit 2; }

# As build-layers.sh: its own mount namespace with every mount private, and
# the host's mount table must be what it was afterwards.
if [ -z "${TC_LAYERS_PRIVATE_NS:-}" ]; then
  mounts() { for f in /proc/1/mountinfo /proc/self/mountinfo; do awk -v f="$f" '{ print f, $5, $9 }' "$f"; done | sort; }
  before=$(mounts)
  rc=0
  TC_LAYERS_PRIVATE_NS=1 unshare --mount --propagation private bash "$0" "$@" || rc=$?
  after=$(mounts)
  if [ "$before" != "$after" ]; then
    echo "build-set.sh: the host's mount table changed during the build:" >&2
    diff <(echo "$before") <(echo "$after") >&2 || true
    exit 3
  fi
  exit "$rc"
fi

mkdir -p "$WORK/debs" "$WORK/lists/$SNAPSHOT" "$OUT"
# One build at a time in WORK: a set a tab asked for waits for the one before
# it, and for the sets built at deploy
exec 8> "$WORK/.lock"
if ! flock -n 8; then echo "::tc:: waiting"; flock 8; fi

BASE_ID=$(node -p 'require(process.argv[1]).id' "$BASE/rootfs.json")
# The names, one a line, from the spec file. They go to apt as words, so each
# must be a Debian package name (policy 5.6.1) and nothing else: it ends in a
# letter, a digit or +, since apt reads a last - as "remove".
mapfile -t PKGS < <(node -e '
  const [file, id] = process.argv.slice(1);
  const l = require(file).layers[id];
  if (!l || !Array.isArray(l.packages) || !l.packages.length) process.exit(1);
  for (const p of [...new Set(l.packages)].sort()) console.log(String(p));
' "$SPEC" "$id")
[ ${#PKGS[@]} -gt 0 ] || { echo "build-set.sh: $SPEC has no packages for $id" >&2; exit 2; }
for p in "${PKGS[@]}"; do
  if ! [[ "$p" =~ ^[a-z0-9][a-z0-9+.-]{0,61}[a-z0-9+]$ ]]; then
    echo "::tc:: refused bad-name A name in this set is not a Debian package name."
    exit 4
  fi
done

recipe=$( { echo "$BASE_ID $SNAPSHOT $MIRROR ${PKGS[*]}"; cat "$0" "$HERE/pack-layer.mjs"; } | sha256sum | cut -c1-16)
if [ -z "${FORCE:-}" ] && [ -f "$OUT/$id/layer.json" ] && grep -q "\"recipe\": \"$recipe\"" "$OUT/$id/layer.json"; then
  echo "== $id: up to date ($recipe)"
  if [ -n "${TC_SET_PIN:-}" ]; then touch "$OUT/$id/pinned"; fi
  exit 0
fi

echo "::tc:: phase resolving"
echo "== $id: ${PKGS[*]} (recipe $recipe)"
# Room first: the sets used longest ago go while the chunks are over the cap
node "$HERE/set-evict.mjs" "$OUT" --max-mb "${TC_SETS_MAX_MB:-3072}" --keep "$id" --debs "$WORK/debs" --debs-max-mb "${TC_SET_DEBS_MAX_MB:-1024}" --specs "$WORK/specs"
free_gb=$(( $(df -Pk "$WORK" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
if [ "$free_gb" -lt "${MIN_FREE_GB:-3}" ]; then
  echo "::tc:: refused busy The server's disk is nearly full."
  echo "build-set.sh: only ${free_gb} GB free on $WORK (need ${MIN_FREE_GB:-3}); not building" >&2
  exit 4
fi

ROOT="$WORK/root"
BASEDIR="$WORK/base-$BASE_ID"
umount_all() {
  for m in var/lib/apt/lists var/cache/apt/archives dev/shm dev/pts dev sys proc; do mountpoint -q "$ROOT/$m" 2>/dev/null && umount "$ROOT/$m" || true; done
}
trap umount_all EXIT
if [ ! -f "$BASEDIR/.complete" ]; then
  umount_all
  rm -rf "$WORK"/base-* "$ROOT"
  node "$HERE/unpack-rootfs.mjs" "$BASE" "$BASEDIR"
  touch "$BASEDIR/.complete"
fi

CA_BUNDLE="${CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}"
APT_OPTS=(-o Acquire::Retries=5 -o Acquire::https::CaInfo=/etc/apt/build-ca.crt)
[ -n "${HTTPS_PROXY:-${https_proxy:-}}" ] && APT_OPTS+=(-o "Acquire::https::Proxy=${HTTPS_PROXY:-$https_proxy}")

# (8>&-: nothing a package starts may hold the build lock)
in_root() { chroot "$ROOT" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8 \
  DEBIAN_FRONTEND=noninteractive SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" "$@" 8>&-; }

umount_all
rm -rf "$ROOT"
cp -a "$BASEDIR" "$ROOT"
rm -f "$ROOT/.complete"

mount -t proc proc "$ROOT/proc"
# A fresh sysfs (none of the host's submounts, such as cgroups) and one-level
# binds of /dev, /dev/pts and /dev/shm, never recursive
mount -t sysfs sysfs "$ROOT/sys"
for d in dev dev/pts dev/shm; do
  mkdir -p "$ROOT/$d"
  mount --bind "/$d" "$ROOT/$d" && mount --make-slave "$ROOT/$d"
done
mount --bind "$WORK/debs" "$ROOT/var/cache/apt/archives"
# The lists of a pinned snapshot never change: fetched once, kept for every later set
mkdir -p "$ROOT/var/lib/apt/lists"
mount --bind "$WORK/lists/$SNAPSHOT" "$ROOT/var/lib/apt/lists"
cp -L /etc/resolv.conf "$ROOT/etc/resolv.conf.build"
mv "$ROOT/etc/resolv.conf" "$ROOT/etc/resolv.conf.keep"
cp "$ROOT/etc/resolv.conf.build" "$ROOT/etc/resolv.conf"

# tabcomputer's overlay stubs (apt's http method is a `#!` to a page program)
# can't run here: Debian's files stand in while apt runs, and dpkg's
# diversions stay as they are.
stubs=()
while IFS=$'\t' read -r from to; do
  if [ -f "$ROOT$to" ]; then
    [ -e "$ROOT$from" ] && mv "$ROOT$from" "$ROOT$from.tc-stub"
    cp -a "$ROOT$to" "$ROOT$from"
    stubs+=("$from")
  fi
done < <(paste - - - < "$ROOT/var/lib/dpkg/diversions" | awk -F'\t' '$3 == ":" && $2 == $1 ".debian" { print $1 "\t" $2 }')

# The pinned archive, main only, only for the build
cp -a "$ROOT/etc/apt/sources.list.d/debian.sources" "$ROOT/etc/apt/debian.sources.keep"
cat > "$ROOT/etc/apt/sources.list.d/debian.sources" <<EOF
Types: deb
URIs: $MIRROR/debian/$SNAPSHOT
Suites: trixie trixie-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
Check-Valid-Until: no

Types: deb
URIs: $MIRROR/debian-security/$SNAPSHOT
Suites: trixie-security
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
Check-Valid-Until: no
EOF
mkdir -p "$ROOT"/usr/share/man/man{1..8}
cp -L "$CA_BUNDLE" "$ROOT/etc/apt/build-ca.crt"
in_root apt-get "${APT_OPTS[@]}" -o APT::Update::Error-Mode=any update
# Which names the archive has, for server.mjs to answer from at once
in_root apt-cache pkgnames | LC_ALL=C sort > "$WORK/names.now"
if [ ! -s "$OUT/names.txt" ] || [ "$OUT/names.txt" -ot "$BASE/rootfs.json" ]; then
  cp "$WORK/names.now" "$OUT/names.txt.tmp"
  mv "$OUT/names.txt.tmp" "$OUT/names.txt"
fi
# Each name must be a package of this snapshot, exactly: apt would otherwise
# read a name it does not have as a pattern and install what matches
for p in "${PKGS[@]}"; do
  if ! grep -qxF -- "$p" "$WORK/names.now"; then
    echo "::tc:: refused unknown-package A name in this set is not in Debian's main archive."
    exit 4
  fi
done
# What the set installs, dependencies included, against the limits: before
# anything is downloaded or run. (An empty archive directory, so packages
# already downloaded for another set are counted too.)
mkdir -p "$ROOT/var/tmp/tc-none/partial"
in_root apt-get "${APT_OPTS[@]}" -o Dir::Cache::archives=/var/tmp/tc-none install -y --print-uris -- "${PKGS[@]}" > "$WORK/uris.txt"
rm -rf "$ROOT/var/tmp/tc-none"
node "$HERE/set-limits.mjs" < "$WORK/uris.txt"

echo "::tc:: phase downloading"
in_root apt-get "${APT_OPTS[@]}" -o APT::Keep-Downloaded-Packages=true install -y --download-only -- "${PKGS[@]}"
echo "::tc:: phase installing"
in_root apt-get "${APT_OPTS[@]}" -o APT::Keep-Downloaded-Packages=true install -y -- "${PKGS[@]}"
in_root ldconfig
# A layer ships with nothing left for dpkg to do (#109), as in build-layers.sh
in_root dpkg --configure --pending
in_root dpkg --triggers-only --pending
audit=$(in_root dpkg --audit 2>&1) || true
pending=$(awk '/^Package:/ { p = $2 } /^Triggers-(Pending|Awaited):/ { print p ": " $0 }' "$ROOT/var/lib/dpkg/status")
if [ -n "$audit" ] || [ -n "$pending" ] || [ -s "$ROOT/var/lib/dpkg/triggers/Unincorp" ]; then
  echo "build-set.sh: $id: dpkg still has work pending after the install:" >&2
  printf '%s\n' "$audit" "$pending" >&2
  cat "$ROOT/var/lib/dpkg/triggers/Unincorp" >&2 2>/dev/null || true
  exit 1
fi

echo "::tc:: phase packing"
# Back to the base's configuration and the overlay's stubs
rm -f "$ROOT/etc/apt/build-ca.crt"
mv "$ROOT/etc/apt/debian.sources.keep" "$ROOT/etc/apt/sources.list.d/debian.sources"
mv "$ROOT/etc/resolv.conf.keep" "$ROOT/etc/resolv.conf"; rm -f "$ROOT/etc/resolv.conf.build"
for from in "${stubs[@]}"; do
  rm -f "$ROOT$from"
  [ -e "$ROOT$from.tc-stub" ] && mv "$ROOT$from.tc-stub" "$ROOT$from"
done
umount_all

rm -rf "$ROOT/var/cache/apt/"*.bin "$ROOT/var/lib/apt/lists/"* && mkdir -p "$ROOT/var/lib/apt/lists/partial"
rm -rf "$ROOT/var/cache/apt/archives/"*.deb "$ROOT/var/cache/apt/archives/partial/"*
find "$ROOT/var/log" -type f -delete
rm -f "$ROOT/var/cache/debconf/"*-old "$ROOT/var/lib/dpkg/"*-old
rm -rf "$ROOT/tmp/"* "$ROOT/var/tmp/"* "$ROOT/root/".bash_history "$ROOT/root/.cache"
find "$ROOT" -xdev -newermt "@$SOURCE_DATE_EPOCH" ! -newermt "@4000000000" -print0 | xargs -0r touch --no-dereference --date="@$SOURCE_DATE_EPOCH"

node "$HERE/pack-layer.mjs" "$BASEDIR" "$ROOT" "$OUT" --id "$id" --spec "$SPEC" --base-id "$BASE_ID" --snapshot "$SNAPSHOT" --recipe "$recipe"
if [ -n "${TC_SET_PIN:-}" ]; then touch "$OUT/$id/pinned"; fi
rm -rf "$ROOT"
echo "== $id: built"
