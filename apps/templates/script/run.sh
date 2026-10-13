#!/bin/sh
# The script this app runs. Its arguments are what was typed in the app's
# "Arguments" box, one per line.
echo "Hello from $APP_ID."
echo "Arguments: $#"
for a in "$@"; do echo "  $a"; done
