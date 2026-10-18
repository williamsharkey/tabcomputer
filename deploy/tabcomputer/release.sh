#!/bin/bash
# Build the checked-out commit and make it the live release.
# Called by the droplet's tabcomputer-deploy (cloud-init.yaml) from the checkout:
#   release.sh <src checkout> <root, /opt/tabcomputer> <commit sha>
set -euo pipefail
src=$1 root=$2 sha=$3
cd "$src"
# The droplet has 2 GB; vite build needs ~1.1 GB of heap, past node's default
# limit there (Build 978's first deploy died "heap out of memory"). Give it 1.5 GB,
# with a swapfile so a peak can't get the live server OOM-killed.
if ! swapon --show=NAME --noheadings | grep -q .; then
  [ -f /swapfile ] || { fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null; }
  swapon /swapfile || echo "swapon failed; building without swap"
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
export NODE_OPTIONS="--max-old-space-size=1536${NODE_OPTIONS:+ $NODE_OPTIONS}"
# /_deploy/status.json (nginx serves /var/www/tabdeploy): the commit asked for,
# the one live, and on a failure the log's last lines, for scripts/predeploy.sh
# --wait and for a person (#156). Never fails the release itself.
deploy_dir=/var/www/tabdeploy
live=$(cat "$root/current/DEPLOYED_SHA" 2>/dev/null || true)
write_status() {
  [ -d "$deploy_dir" ] || return 0
  node -e 'const [state, asked, live, log] = process.argv.slice(1); let tail = "";
    try { if (log) tail = require("fs").readFileSync(log, "utf8").trimEnd().split("\n").slice(-30).join("\n"); } catch {}
    process.stdout.write(JSON.stringify({ state, asked, live, at: new Date().toISOString(), ...(tail ? { tail } : {}) }, null, 1) + "\n");' \
    "$@" > "$deploy_dir/status.json.tmp" && mv -f "$deploy_dir/status.json.tmp" "$deploy_dir/status.json" || true
}
write_status building "$sha" "$live"
trap 'write_status failed "$sha" "$live" "$deploy_dir/log.new"' ERR
npm ci --no-audit --no-fund
npm run build
rel=$root/releases/$sha
rm -rf "$rel"; mkdir -p "$rel/public"
rsync -a dist/ "$rel/public/"
# Tabs opened before this deploy still import the old hashed chunks, so keep
# the live release's assets (themselves carried forward) for a week.
if [ -d "$root/current/public/assets" ]; then
  (cd "$root/current/public/assets" && find . -type f -mtime -7 -print0) |
    rsync -a --ignore-existing --from0 --files-from=- "$root/current/public/assets/" "$rel/public/assets/"
fi
# Same for the Blink engine versions those tabs run (engines/blink/v-<sha>/, #18)
if [ -d "$root/current/public/engines/blink" ]; then
  find "$root/current/public/engines/blink" -mindepth 1 -maxdepth 1 -type d -name 'v-*' -mtime -7 -print0 |
    while IFS= read -r -d '' d; do [ -e "$rel/public/engines/blink/${d##*/}" ] || cp -a "$d" "$rel/public/engines/blink/"; done
fi
cp server.mjs "$rel/server.mjs"
cp profiles/tabcomputer/server.env "$rel/server.env"
echo "$sha" > "$rel/DEPLOYED_SHA"
echo "$sha" > "$rel/public/deployed.txt"
ln -sfn "$rel" "$root/current.new" && mv -T "$root/current.new" "$root/current"
# Package layers (docs/DEBIAN.md "Package layers"): the tools server.mjs builds
# a requested set with (TABCOMPUTER_LAYER_BUILDER in server.env), as a copy of
# their own so a toolchain build in flight never keeps them from a release.
# Swapped in whole; a failure here leaves the old tools and never stops the deploy.
install_set_tools() {
  local tools=$root/set-build/tools
  # (each step checked by hand: `set -e` does not act inside `f || ...`)
  rm -rf "$tools.new" "$tools.old"
  mkdir -p "$tools.new" || return 1
  cp scripts/debian/build-set.sh scripts/debian/pack-layer.mjs scripts/debian/unpack-rootfs.mjs \
    scripts/debian/set-key.mjs scripts/debian/set-limits.mjs scripts/debian/set-evict.mjs src/debian/package-sets.json "$tools.new/" || return 1
  if [ -d "$tools" ]; then mv -T "$tools" "$tools.old" || return 1; fi
  mv -T "$tools.new" "$tools" || return 1
  rm -rf "$tools.old"
}
install_set_tools || echo "package set tools not installed"
systemctl restart tabcomputer
trap - ERR
write_status live "$sha" "$sha"
bash deploy/tabcomputer/tls-install.sh "$src" || true
# Toolchain layers (docs/DEBIAN.md "Toolchain layers") build in the
# background, outside the release, and never fail or hold up the deploy:
# only sets whose recipe changed are rebuilt (usually none), at idle
# priority with half a CPU, and server.mjs serves $root/layers (server.env).
# The builder runs from a copy, so the next deploy's checkout can't change
# it mid-build, and in its own mount namespace (PrivateMounts), so its chroot
# mounts can never reach the host's (a shared rbind of /sys once unmounted
# the host's cgroup tree and left systemd unable to start any unit).
start_layer_build() {
  if systemctl is-active --quiet tabcomputer-layers; then
    echo "layer build still running; this release's recipes are built on the next deploy"; return 0
  fi
  local tools=$root/layer-build/tools
  rm -rf "$tools"; mkdir -p "$tools"
  cp scripts/debian/build-layers.sh scripts/debian/build-deploy.sh scripts/debian/build-set.sh scripts/debian/pack-layer.mjs scripts/debian/unpack-rootfs.mjs \
    scripts/debian/set-key.mjs scripts/debian/set-limits.mjs scripts/debian/set-evict.mjs src/debian/toolchains.json src/debian/package-sets.json "$tools/"
  systemctl reset-failed tabcomputer-layers 2>/dev/null || true
  # build-deploy.sh: the toolchain layers as before (build-layers.sh), then the
  # package sets of package-sets.json into $root/layers/sets (build-set.sh;
  # docs/DEBIAN.md "Package layers"). Sets a tab asks for are built by
  # server.mjs with the same build-set.sh, in $root/set-build
  # (TABCOMPUTER_LAYER_BUILDER in server.env).
  systemd-run --unit=tabcomputer-layers --no-block -p PrivateMounts=yes -p Nice=19 -p IOSchedulingClass=idle -p CPUQuota=50% \
    -E BASE="$rel/public/debian" -E OUT="$root/layers" -E WORK="$root/layer-build" -E SPEC="$tools/toolchains.json" -E PRUNE=1 \
    -E SETS_WORK="$root/set-build" \
    bash "$tools/build-deploy.sh"
}
start_layer_build || echo "layer build not started"
ls -1dt "$root"/releases/* | tail -n +4 | xargs -r rm -rf
echo "deployed $sha"
