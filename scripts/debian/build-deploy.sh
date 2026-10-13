#!/usr/bin/env bash
# What a deploy builds in the background (deploy/tabcomputer/release.sh, unit
# tabcomputer-layers): the toolchain layers, then the package sets of
# src/debian/package-sets.json (docs/DEBIAN.md "Package layers"). Both only
# when their recipe changed. The toolchain build runs first and exactly as
# before (build-layers.sh, unchanged); a failure there does not stop the sets.
#
#   BASE OUT WORK SPEC [PRUNE]   as for build-layers.sh (the toolchain layers)
#   SETS       the sets to build ahead (default: package-sets.json next to this script)
#   SETS_WORK  scratch directory for package sets (default: WORK/../set-build),
#              shared with the builds server.mjs starts, one at a time
#
# The sets go to OUT/sets, where server.mjs looks for them
# (TABCOMPUTER_DEBIAN_LAYERS/sets), and are marked `pinned`: the disk cap
# never removes them.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
rc=0
bash "$HERE/build-layers.sh" "$@" || rc=$?

SETS="${SETS:-$HERE/package-sets.json}"
SETS_WORK="${SETS_WORK:-$(dirname "$WORK")/set-build}"
if [ -f "$SETS" ]; then
  mkdir -p "$SETS_WORK/specs" "$OUT/sets"
  # (stdin from /dev/null: nothing in a build may read the list of sets)
  while read -r key spec; do
    [ -n "$key" ] || continue
    env -u PRUNE -u FORCE BASE="$BASE" OUT="$OUT/sets" WORK="$SETS_WORK" SPEC="$spec" TC_SET_PIN=1 \
      bash "$HERE/build-set.sh" "$key" < /dev/null || { echo "build-deploy.sh: set $key failed" >&2; rc=1; }
  done < <(node "$HERE/set-key.mjs" specs "$BASE" "$SETS" "$SETS_WORK/specs")
fi
exit "$rc"
