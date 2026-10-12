#!/usr/bin/env bash
# Build tabcomputer's toolchain layers (docs/DEBIAN.md "Toolchain layers"):
# for each set in src/debian/toolchains.json, apt-get install its packages in
# a chroot of exactly the base rootfs users install (rebuilt from
# public/debian by unpack-rootfs.mjs), from the base's pinned
# snapshot.debian.org timestamp, then pack what changed
# (pack-layer.mjs) into OUT/<id>/.
#
#   sudo bash scripts/debian/build-layers.sh [ID...]     # default: every set
#
# Environment:
#   BASE      packed base rootfs (default public/debian)
#   OUT       where layers go (default .toolchain-build/layers; server.mjs serves
#             TABCOMPUTER_DEBIAN_LAYERS at /debian/layers/)
#   WORK      scratch directory (default .toolchain-build/)
#   SPEC      the sets (default src/debian/toolchains.json)
#   SNAPSHOT  snapshot.debian.org timestamp (default: the base's)
#   MIRROR    archive URL prefix (default https://snapshot.debian.org/archive)
#   FORCE=1   rebuild layers whose recipe hash is unchanged
#   PRUNE=1   afterwards, delete chunks and indexes of all but each set's
#             current and previous build
#   MIN_FREE_GB  refuse to start with less free disk on WORK (default 6). A set
#             that needs more says so ("disk_gb") and is skipped, not failed,
#             when WORK has less
#   CA_BUNDLE CA certificates apt uses for https (default: the host's
#             /etc/ssl/certs/ca-certificates.crt; minbase has none)
#   HTTPS_PROXY  passed to apt as Acquire::https::Proxy when set
#
# A set that "extends" another is built with that set's packages and prepare
# steps first, then its own. Its layer is a superset: a tab applies it
# instead of the other (tex-full extends tex).
#
# A layer is rebuilt only when its recipe changes: the hash of the base id,
# the snapshot, the package list and this script and pack-layer.mjs. Old
# chunks stay (content-addressed; browsers that applied an older layer
# still fetch from them). Needs root (chroot, mounts), node, curl.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
BASE="${BASE:-$REPO/public/debian}"
OUT="${OUT:-$REPO/.toolchain-build/layers}"
WORK="${WORK:-$REPO/.toolchain-build}"
SPEC="${SPEC:-$REPO/src/debian/toolchains.json}"
SNAPSHOT="${SNAPSHOT:-$(node -p 'require(process.argv[1]).snapshot' "$BASE/rootfs.json")}"
MIRROR="${MIRROR:-https://snapshot.debian.org/archive}"
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1790812800}"

[ "$(id -u)" = 0 ] || { echo "build-layers.sh: run as root (it chroots)" >&2; exit 1; }

# The chroot's mounts must never reach the host's: a shared rbind of /sys,
# unmounted with umount -l, once took the host's /sys/fs/cgroup with it and
# systemd could start no unit after that. So the build runs in its own mount
# namespace with every mount private, and afterwards the caller's and PID 1's
# mount tables must be what they were (the guard fails the build otherwise).
if [ -z "${TC_LAYERS_PRIVATE_NS:-}" ]; then
  mounts() { for f in /proc/1/mountinfo /proc/self/mountinfo; do awk -v f="$f" '{ print f, $5, $9 }' "$f"; done | sort; }
  before=$(mounts)
  rc=0
  TC_LAYERS_PRIVATE_NS=1 unshare --mount --propagation private bash "$0" "$@" || rc=$?
  after=$(mounts)
  if [ "$before" != "$after" ]; then
    echo "build-layers.sh: the host's mount table changed during the build:" >&2
    diff <(echo "$before") <(echo "$after") >&2 || true
    exit 3
  fi
  exit "$rc"
fi
BASE_ID=$(node -p 'require(process.argv[1]).id' "$BASE/rootfs.json")
IDS=("$@")
[ ${#IDS[@]} -gt 0 ] || mapfile -t IDS < <(node -e 'for (const k of Object.keys(require(process.argv[1]).layers)) console.log(k)' "$SPEC")

mkdir -p "$WORK/debs" "$OUT"
free_gb=$(( $(df -Pk "$WORK" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
if [ "$free_gb" -lt "${MIN_FREE_GB:-6}" ]; then
  echo "build-layers.sh: only ${free_gb} GB free on $WORK (need ${MIN_FREE_GB:-6}); not building" >&2; exit 1
fi
ROOT="$WORK/root"
BASEDIR="$WORK/base-$BASE_ID"
if [ ! -f "$BASEDIR/.complete" ]; then
  rm -rf "$WORK"/base-*
  node "$HERE/unpack-rootfs.mjs" "$BASE" "$BASEDIR"
  touch "$BASEDIR/.complete"
fi

umount_all() {
  for m in var/cache/apt/archives dev/shm dev/pts dev sys proc; do mountpoint -q "$ROOT/$m" 2>/dev/null && umount "$ROOT/$m" || true; done
}
trap umount_all EXIT

CA_BUNDLE="${CA_BUNDLE:-/etc/ssl/certs/ca-certificates.crt}"
APT_OPTS=(-o Acquire::Retries=5 -o Acquire::https::CaInfo=/etc/apt/build-ca.crt)
[ -n "${HTTPS_PROXY:-${https_proxy:-}}" ] && APT_OPTS+=(-o "Acquire::https::Proxy=${HTTPS_PROXY:-$https_proxy}")

in_root() { chroot "$ROOT" /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8 \
  DEBIAN_FRONTEND=noninteractive SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" "$@"; }

# A set's recipe fields, those of the sets it extends first:
#   spec ID packages | prepare (a command a line) | prepare-json | disk_gb
spec() {
  node -e '
    const [file, id, what] = process.argv.slice(1);
    const layers = require(file).layers;
    const chain = [];
    for (let i = id; i; i = layers[i].extends) {
      if (!layers[i]) { console.error("no layer " + i); process.exit(1); }
      if (chain.length > 8) { console.error(id + ": extends itself"); process.exit(1); }
      chain.unshift(layers[i]);
    }
    const prepare = chain.flatMap((l) => l.prepare || []);
    if (what === "packages") console.log([...new Set(chain.flatMap((l) => l.packages))].join(" "));
    else if (what === "prepare") console.log(prepare.join("\n"));
    else if (what === "prepare-json") console.log(JSON.stringify(prepare));
    else if (what === "disk_gb") console.log(layers[id].disk_gb || 0);
    else process.exit(2);
  ' "$SPEC" "$1" "$2"
}

for id in "${IDS[@]}"; do
  pkgs=$(spec "$id" packages)
  recipe=$( { echo "$BASE_ID $SNAPSHOT $MIRROR $pkgs"; spec "$id" prepare-json; cat "$0" "$HERE/pack-layer.mjs"; } | sha256sum | cut -c1-16)
  if [ -z "${FORCE:-}" ] && [ -f "$OUT/$id/layer.json" ] && grep -q "\"recipe\": \"$recipe\"" "$OUT/$id/layer.json"; then
    echo "== $id: up to date ($recipe)"; continue
  fi
  # A big set (tex-full: its .debs, the unpacked tree and the chunks at
  # once) waits for a disk with room instead of filling this one
  need_gb=$(spec "$id" disk_gb)
  free_gb=$(( $(df -Pk "$WORK" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
  if [ "$free_gb" -lt "$need_gb" ]; then
    echo "== $id: skipped: it needs ${need_gb} GB free on $WORK, and there are ${free_gb}" >&2; continue
  fi
  echo "== $id: $pkgs (recipe $recipe)"
  umount_all
  rm -rf "$ROOT"
  cp -a "$BASEDIR" "$ROOT"
  rm -f "$ROOT/.complete"

  mount -t proc proc "$ROOT/proc"
  # A fresh sysfs (none of the host's submounts, such as cgroups) and
  # one-level binds of /dev, /dev/pts and /dev/shm, never recursive
  mount -t sysfs sysfs "$ROOT/sys"
  for d in dev dev/pts dev/shm; do
    mkdir -p "$ROOT/$d"
    mount --bind "/$d" "$ROOT/$d" && mount --make-slave "$ROOT/$d"
  done
  mount --bind "$WORK/debs" "$ROOT/var/cache/apt/archives"
  cp -L /etc/resolv.conf "$ROOT/etc/resolv.conf.build"
  mv "$ROOT/etc/resolv.conf" "$ROOT/etc/resolv.conf.keep"
  cp "$ROOT/etc/resolv.conf.build" "$ROOT/etc/resolv.conf"

  # tabcomputer's overlay stubs (apt's http method is a `#!` to a page
  # program) can't run here: Debian's files stand in while apt runs, and
  # dpkg's diversions stay as they are.
  stubs=()
  while IFS=$'\t' read -r from to; do
    if [ -f "$ROOT$to" ]; then
      [ -e "$ROOT$from" ] && mv "$ROOT$from" "$ROOT$from.tc-stub"
      cp -a "$ROOT$to" "$ROOT$from"
      stubs+=("$from")
    fi
  done < <(paste - - - < "$ROOT/var/lib/dpkg/diversions" | awk -F'\t' '$3 == ":" && $2 == $1 ".debian" { print $1 "\t" $2 }')

  # The pinned archive, only for the build
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
  # The base leaves man pages out but keeps dpkg's man[1-9] includes; an
  # update-alternatives link into a missing man directory fails the
  # postinst (openjdk's java.1.gz), as on Docker's slim images
  mkdir -p "$ROOT"/usr/share/man/man{1..8}
  cp -L "$CA_BUNDLE" "$ROOT/etc/apt/build-ca.crt"
  in_root apt-get "${APT_OPTS[@]}" -o APT::Update::Error-Mode=any update
  # shellcheck disable=SC2086
  in_root apt-get "${APT_OPTS[@]}" -o APT::Keep-Downloaded-Packages=true install -y $pkgs
  in_root ldconfig
  # The set's own preparation (toolchains.json "prepare"), e.g. Go's std
  # compiled into the build cache so the tab doesn't compile it under Blink
  prepare=$(spec "$id" prepare)
  if [ -n "$prepare" ]; then
    printf '%s\n' "$prepare" > "$ROOT/tmp/tc-prepare.sh"
    in_root sh -e /tmp/tc-prepare.sh
    rm -f "$ROOT/tmp/tc-prepare.sh"
  fi
  # A layer ships with nothing left for dpkg to do (#109). apt has configured
  # the packages and run their triggers by now (TeX's formats, ls-R, updmap;
  # ldconfig); whatever is still unconfigured, or was triggered since (a
  # prepare step can activate triggers), runs here, natively, and not in the
  # tab under Blink at the user's next apt run. Then dpkg must agree that
  # nothing is pending; pack-layer.mjs checks the tree it packs as well.
  in_root dpkg --configure --pending
  in_root dpkg --triggers-only --pending
  audit=$(in_root dpkg --audit 2>&1) || true
  pending=$(awk '/^Package:/ { p = $2 } /^Triggers-(Pending|Awaited):/ { print p ": " $0 }' "$ROOT/var/lib/dpkg/status")
  if [ -n "$audit" ] || [ -n "$pending" ] || [ -s "$ROOT/var/lib/dpkg/triggers/Unincorp" ]; then
    echo "build-layers.sh: $id: dpkg still has work pending after the install:" >&2
    printf '%s\n' "$audit" "$pending" >&2
    cat "$ROOT/var/lib/dpkg/triggers/Unincorp" >&2 2>/dev/null || true
    exit 1
  fi

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
  # Times after the snapshot are clamped to it, except ones a prepare step set
  # far in the future on purpose (Go's cache entries: see toolchains.json)
  find "$ROOT" -xdev -newermt "@$SOURCE_DATE_EPOCH" ! -newermt "@4000000000" -print0 | xargs -0r touch --no-dereference --date="@$SOURCE_DATE_EPOCH"

  node "$HERE/pack-layer.mjs" "$BASEDIR" "$ROOT" "$OUT" --id "$id" --spec "$SPEC" --base-id "$BASE_ID" --snapshot "$SNAPSHOT" --recipe "$recipe"
  # Each finished layer is served right away
  node "$HERE/pack-layer.mjs" --catalog "$OUT" --spec "$SPEC"
done
umount_all
rm -rf "$ROOT"
node "$HERE/pack-layer.mjs" --catalog "$OUT" --spec "$SPEC" ${PRUNE:+--prune}
