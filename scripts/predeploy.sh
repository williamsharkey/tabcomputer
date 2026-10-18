#!/bin/bash
# Before and after a push to `deploy` (docs/RELEASES.md, tabcomputer#156).
#
#   scripts/predeploy.sh            CI's verdict on HEAD (pushed to a unix/ or coord/
#                                   branch): waits for the run, prints each step, fails
#                                   when tsc or the build failed, as on the droplet
#   scripts/predeploy.sh --local    the droplet's steps here instead: a clean copy of
#                                   HEAD, npm ci and npm run build with the droplet's
#                                   1.5 GB heap, and the files release.sh copies
#   scripts/predeploy.sh --wait [SHA]
#                                   after the push: follows /_deploy/status.json until
#                                   SHA (default HEAD) is live, or prints why it failed
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
sha=$(git rev-parse HEAD)
site=${TABCOMPUTER_SITE:-https://tabcomputer.com}

case "${1:-}" in
--wait)
  want=$(git rev-parse "${2:-HEAD}")
  echo "waiting for $site to run ${want:0:8}"
  for _ in $(seq 1 80); do
    st=$(curl -sf "$site/_deploy/status.json" || true)
    if [ -n "$st" ]; then
      read -r state asked < <(node -e 'const s = JSON.parse(process.argv[1]); console.log(s.state, s.asked)' "$st")
      if [ "$asked" = "$want" ] && [ "$state" = live ]; then echo "live: ${want:0:8}"; exit 0; fi
      if [ "$asked" = "$want" ] && [ "$state" = failed ]; then
        echo "the deploy of ${want:0:8} failed; the live release is unchanged. The log's end:"
        node -e 'console.log(JSON.parse(process.argv[1]).tail ?? "")' "$st"; exit 1
      fi
    elif [ "$(curl -sf "$site/deployed.txt" || true)" = "$want" ]; then
      echo "live: ${want:0:8} (this server has no status.json yet)"; exit 0
    fi
    sleep 15
  done
  echo "not live after 20 minutes; see $site/_deploy/log"; exit 1 ;;

--local)
  tree=$(mktemp -d "${TMPDIR:-/tmp}/predeploy.XXXXXX")
  trap 'git worktree remove --force "$tree" >/dev/null 2>&1 || rm -rf "$tree"' EXIT
  git worktree add --detach -q "$tree" "$sha"
  cd "$tree"
  for f in server.mjs profiles/tabcomputer/server.env deploy/tabcomputer/tls-install.sh \
    scripts/debian/build-set.sh scripts/debian/pack-layer.mjs scripts/debian/unpack-rootfs.mjs scripts/debian/set-key.mjs \
    scripts/debian/set-limits.mjs scripts/debian/set-evict.mjs scripts/debian/build-layers.sh scripts/debian/build-deploy.sh \
    src/debian/package-sets.json src/debian/toolchains.json; do
    [ -e "$f" ] || { echo "release.sh copies $f, and this commit has none"; exit 1; }
  done
  NODE_OPTIONS="--max-old-space-size=1536" npm ci --no-audit --no-fund
  NODE_OPTIONS="--max-old-space-size=1536" npm run build
  echo "ok: ${sha:0:8} builds as the droplet builds it" ;;

"")
  echo "CI for ${sha:0:8}"
  run=""
  for _ in $(seq 1 20); do
    run=$(gh run list --commit "$sha" --workflow CI --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)
    [ -n "$run" ] && break
    sleep 15
  done
  [ -n "$run" ] || { echo "no CI run for ${sha:0:8}: push it to a unix/ or coord/ branch first"; exit 1; }
  gh run watch "$run" --exit-status >/dev/null 2>&1 || true
  gh run view "$run" --json jobs -q '.jobs[] | .name as $j | .steps[] | select(.conclusion != null and .conclusion != "skipped") | "\($j)\t\(.conclusion)\t\(.name)"' | column -t -s $'\t'
  bad=$(gh run view "$run" --json jobs -q '[.jobs[] | select(.name == "test") | .steps[] | select((.name == "tsc" or (.name | startswith("build"))) and .conclusion != "success")] | length')
  [ "$bad" = 0 ] || { echo "tsc or the build failed: the droplet would fail too"; exit 1; }
  echo "ok: tsc and the build pass in CI (the test and browser steps above are for a person to read)" ;;

*) sed -n '2,13p' "$0"; exit 2 ;;
esac
