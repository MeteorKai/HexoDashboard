#!/bin/bash
# macOS: double-click after chmod +x, or pass the Hexo blog directory as $1.
APP="$(cd -- "$(dirname "$0")" && pwd)" || exit 1
cd -- "$APP" || exit 1

NODE_EXE="$(command -v node || true)"
if [ -z "$NODE_EXE" ]; then
  for candidate in "$APP/node/node" /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      NODE_EXE="$candidate"
      export PATH="$(dirname "$candidate"):$PATH"
      break
    fi
  done
fi

if [ -z "$NODE_EXE" ] || [ ! -f "$APP/src/server.js" ]; then
  echo "[x] Node.js or src/server.js is missing. Install macOS Node.js and keep the app folder together."
  [ ! -t 0 ] || read -r -p "Press Enter to close... "
  exit 1
fi

BLOG="${1:-${HEXO_BLOG:-}}"

echo "[*] Node      : $NODE_EXE"
echo "[*] Blog and port: saved settings, or configure them on the page."
echo "[*] Stop the server from the page, or press Ctrl+C in this terminal."
"$NODE_EXE" "$APP/src/server.js" "$BLOG" --open
RESULT=$?
echo "[*] Server stopped (exit $RESULT)."
[ ! -t 0 ] || read -r -p "Press Enter to close... "
exit "$RESULT"
