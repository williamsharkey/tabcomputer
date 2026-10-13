#!/bin/bash
# Build public/java/javad.jar (committed, so a normal `npm run build` needs no JDK)
# from scripts/java/Javad.java. Needs a JDK 21 javac and jar: JAVA_HOME, or on PATH.
#   scripts/java/build.sh
# The jar holds class files for Java 21 only; it runs on the java toolchain's OpenJDK 21.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
BIN="${JAVA_HOME:+$JAVA_HOME/bin/}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
"${BIN}javac" --release 21 -d "$TMP" "$HERE/JavadClient.java"
# Javad uses javac's task pool (jdk.compiler's internal api package): no --release with --add-exports
"${BIN}javac" -source 21 -target 21 -Xlint:-options -Xlint:-removal -nowarn \
  --add-exports jdk.compiler/com.sun.tools.javac.api=ALL-UNNAMED \
  --add-exports jdk.compiler/com.sun.tools.javac.code=ALL-UNNAMED \
  --add-exports jdk.compiler/com.sun.tools.javac.util=ALL-UNNAMED -d "$TMP" "$HERE/Javad.java"
mkdir -p "$ROOT/public/java"
# fixed times and order, so the same source gives the same jar
find "$TMP" -name '*.class' -exec touch -t 202601010000 {} +
(cd "$TMP" && ls *.class | LC_ALL=C sort | TZ=UTC zip -q -X -@ "$ROOT/public/java/javad.jar.new")
mv "$ROOT/public/java/javad.jar.new" "$ROOT/public/java/javad.jar"
ls -la "$ROOT/public/java/javad.jar"
