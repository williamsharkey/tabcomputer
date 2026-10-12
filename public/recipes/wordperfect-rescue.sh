#!/bin/bash
# title: Rescue old documents (WordPerfect, Works, ClarisWorks, Visio, CorelDraw)
# for: people with old files they can't open and won't upload
# needs: debian
# on-open: cd ~/run/wordperfect-rescue
# status: untested
set -e
have() { command -v "$1" >/dev/null 2>&1; }

if ! have wpd2html; then
  debian status >/dev/null 2>&1 || debian install
  sudo apt-get update
  sudo apt-get install -y libwpd-tools libmwaw-tools libvisio-tools libcdr-tools
fi
mkdir -p in out
cat > convert-all <<'SH'
#!/bin/bash
# Put files in ./in, run ./convert-all, collect results in ./out
for f in in/*; do
  b=out/$(basename "${f%.*}")
  case "${f,,}" in
    *.wpd|*.wp|*.wp5|*.wp6) wpd2html "$f" > "$b.html" ;;
    *.wps|*.cwk|*.mw|*.mcw)  mwaw2html "$f" > "$b.html" ;;
    *.vsd|*.vsdx)            vsd2xhtml "$f" > "$b.xhtml" ;;
    *.cdr)                   cdr2xhtml "$f" > "$b.xhtml" ;;
    *) echo "skip $f (unknown type)"; continue ;;
  esac && echo "ok   $f"
done
SH
chmod +x convert-all
echo "Put files in ~/run/wordperfect-rescue/in (Files can upload them), then run ./convert-all"
