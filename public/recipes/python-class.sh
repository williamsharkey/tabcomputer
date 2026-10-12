#!/bin/bash
# title: Python class
# for: students on machines where Python can't be installed
# needs: debian toolchain:python net
# args: repo (optional https URL of the course's repository), pip (optional package names, space-separated)
# on-open: cd ~/run/python-class/work
# status: untested
set -e
# python3 is a tabcomputer builtin until Debian's is installed, so ask toolchain rather than PATH
toolchain list | grep -q '^python  *yes' || toolchain install python
mkdir -p work && cd work
if [ -n "$RUN_REPO" ] && [ ! -d .git ]; then
  case "$RUN_REPO" in
    https://*) git clone -- "$RUN_REPO" . ;;
    *) echo "python-class: repo must be an https:// URL; not cloned" ;;
  esac
fi
echo "Ready: python3 (numpy, requests and yaml are installed). Try: python3"
# Installing a package runs its code, and the link chose the names: the person installs them
pip="python3 -m pip install --user --break-system-packages"
if [ -n "$RUN_PIP" ]; then
  case "$RUN_PIP" in
    -*|*" -"*|*[!A-Za-z0-9._\ -]*) echo "python-class: the link's package list is not plain package names; ignored" ;;
    *) echo "This link suggests packages. To install them: $pip $RUN_PIP" ;;
  esac
fi
if [ -f requirements.txt ]; then echo "To install this project's packages: $pip -r requirements.txt"; fi
