#!/bin/bash
# title: Look inside a repo or archive you don't trust
# for: people sent a repository or tarball they don't trust (a "take-home test", an "NDA branch")
# needs: net
# args: url (optional https URL of a git repository or an archive; or put files in ~/run/untrusted-repo/in)
# on-open: cd ~/run/untrusted-repo
# This tab has none of your SSH keys or files, so a hook that fires only reaches the tab.
# It can still reach the internet through the relay; use a fresh tab and sign in to nothing.
set -e
mkdir -p in box
if [ -n "$RUN_URL" ]; then
  case "$RUN_URL" in
    https://*.git|https://github.com/*|https://gitlab.com/*)
      [ -d box/repo ] || git -c core.hooksPath=/dev/null clone --no-checkout -- "$RUN_URL" box/repo ;;
    https://*) [ -e in/archive ] || curl -fsSL -o in/archive "$RUN_URL" ;;
    *) echo "untrusted-repo: url must be an https:// URL; nothing fetched" ;;
  esac
fi
# Archives are listed, not unpacked: unpacking is the person's decision
for f in in/*; do
  [ -f "$f" ] || continue
  echo "== $f holds:"
  tar -tvf "$f" 2>/dev/null | head -n 40
  echo "   unpack it with: tar -xf $f -C box"
done
echo "== hooks that would run (not .sample):"
find box -path '*/.git/hooks/*' -type f ! -name '*.sample' 2>/dev/null
echo "== .git/config keys that run programs:"
grep -RnE 'hooksPath|fsmonitor|sshCommand|pager|editor|filter\.|\[alias' box/*/.git/config box/.git/config 2>/dev/null || echo "(none)"
echo "Inspect with: git -C box/repo log --stat   or   git -C box/repo show <branch>:<file>"
