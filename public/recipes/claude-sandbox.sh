#!/bin/bash
# title: Claude Code in a throwaway machine
# for: people who want a coding agent that can't touch their real disk
# needs: claude net
# profile: shiro
# args: repo (optional https URL of the repository to work on)
# on-open: cd ~/run/claude-sandbox/work
# status: untested
set -e
mkdir -p work && cd work
if [ -n "$RUN_REPO" ] && [ ! -d .git ]; then
  case "$RUN_REPO" in
    https://*) git clone -- "$RUN_REPO" . ;;
    *) echo "claude-sandbox: repo must be an https:// URL; not cloned" ;;
  esac
fi
echo "This machine is a browser tab: the agent sees only these files."
echo "Push your work with git, or download it from Files. Start with: claude"
