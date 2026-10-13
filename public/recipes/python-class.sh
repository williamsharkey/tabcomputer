#!/bin/bash
# title: Python class
# for: students on machines where Python can't be installed
# needs: net
# args: repo (optional https URL of the course's repository), pip (optional package names, space-separated)
# on-open: cd ~/run/python-class/work
set -e
# python3 is the built-in Python: nothing to install here (it fetches itself the first time it runs).
# pip installs numpy, pandas and matplotlib for it. Only tkinter and turtle need Debian's Python,
# and python3 says so when a program imports them.
mkdir -p work && cd work
if [ -n "$RUN_REPO" ] && [ ! -d .git ]; then
  case "$RUN_REPO" in
    https://*) git clone -- "$RUN_REPO" . ;;
    *) echo "python-class: repo must be an https:// URL; not cloned" ;;
  esac
fi
echo "Ready: python3. Try: python3"
echo "For numpy, pandas or matplotlib: pip install numpy pandas matplotlib"
echo "For turtle or tkinter: toolchain install python"
# Installing a package runs its code, and the link chose the names: the person installs them
pip="pip install"
if [ -n "$RUN_PIP" ]; then
  case "$RUN_PIP" in
    -*|*" -"*|*[!A-Za-z0-9._\ -]*) echo "python-class: the link's package list is not plain package names; ignored" ;;
    *) echo "This link suggests packages. To install them: $pip $RUN_PIP" ;;
  esac
fi
if [ -f requirements.txt ]; then echo "To install this project's packages: $pip -r requirements.txt"; fi
