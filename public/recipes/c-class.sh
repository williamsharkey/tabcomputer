#!/bin/bash
# title: C programming class
# for: students and teachers on managed Chromebooks and laptops where nothing can be installed
# needs: debian toolchain:c net
# args: repo (optional https URL of the starter code)
# on-open: cd ~/run/c-class/work
set -e
# gcc is a tabcomputer builtin until Debian's is installed, so ask toolchain rather than PATH
toolchain list | grep -q '^c  *yes' || toolchain install c
mkdir -p work && cd work
if [ -n "$RUN_REPO" ] && [ ! -d .git ]; then
  case "$RUN_REPO" in
    https://*) git clone -- "$RUN_REPO" . ;;
    *) echo "c-class: repo must be an https:// URL; not cloned" ;;
  esac
fi
[ -e hello.c ] || [ -d .git ] || printf '#include <stdio.h>\nint main(void){puts("hello from tabcomputer");return 0;}\n' > hello.c
echo "Ready: gcc, g++, make. Try: gcc hello.c && ./a.out"
