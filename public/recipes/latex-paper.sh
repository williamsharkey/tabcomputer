#!/bin/bash
# title: LaTeX project, no compile time limit
# for: people whose paper hits an online editor's compile timeout, or who can't upload it
# needs: debian toolchain:tex net
# args: repo (optional https URL of the paper's repository), main (main .tex file, default main.tex)
# on-open: cd ~/run/latex-paper/work
# status: untested
set -e
have() { command -v "$1" >/dev/null 2>&1; }

have pdflatex || toolchain install tex
mkdir -p work && cd work
if [ -n "$RUN_REPO" ] && [ ! -d .git ]; then
  case "$RUN_REPO" in
    https://*) git clone -- "$RUN_REPO" . ;;
    *) echo "latex-paper: repo must be an https:// URL; not cloned" ;;
  esac
fi
main=${RUN_MAIN:-main.tex}
case "$main" in -*|/*|*..*|*[!A-Za-z0-9._/-]*) main=main.tex ;; esac
# latexmk runs the project's own code (.latexmkrc), so the person starts the build
if [ -f "$main" ]; then
  echo "Ready. Build the paper with: latexmk -pdf -interaction=nonstopmode $main"
else
  echo "Ready: pdflatex, latexmk. Put your .tex files in ~/run/latex-paper/work, then: latexmk -pdf main.tex"
fi
