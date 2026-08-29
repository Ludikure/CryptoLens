#!/bin/bash
# Assemble a .dc.html artboard from a body fragment + the shared token stylesheet.
# Artboards share nothing at runtime, so every file carries its own copy.
set -e
name="$1"; w="$2"; h="$3"
{
  printf '<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <script src="./support.js"></script>\n</head>\n<body>\n<x-dc>\n<helmet>\n  <style>\n'
  cat _shared.css
  [ -f "body/$name.css" ] && cat "body/$name.css"
  printf '  </style>\n</helmet>\n'
  cat "body/$name.html"
  printf '</x-dc>\n<script data-dc-script data-props='"'"'{"$preview":{"width":%s,"height":%s}}'"'"'>\nclass Component extends DCLogic {}\n</script>\n</body>\n</html>\n' "$w" "$h"
} > "$name.dc.html"
echo "wrote $name.dc.html ($(wc -c < "$name.dc.html") bytes)"
