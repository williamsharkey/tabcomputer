#!/bin/sh
# Builds the GL probes (glbench, pbuffer, glcore) (x86-64, glibc ≤ 2.36) into $1 (default: this directory's out/).
set -e
cd "$(dirname "$0")"
out=${1:-out}
mkdir -p "$out"
for p in glbench pbuffer glcore; do
  gcc -O2 -Wall -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0 -fno-stack-protector -o "$out/$p" $p.c -lX11 -ldl
  objdump -T "$out/$p" | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1
done
