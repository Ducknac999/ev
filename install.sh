#!/bin/bash
# E.V installer. Paste into Terminal:
#   curl -fsSL https://raw.githubusercontent.com/Ducknac999/ev/main/install.sh | bash
# Downloads the latest E.V from this repo's Releases into Applications and opens it.
set -euo pipefail
REPO="Ducknac999/ev"

[ "$(uname -s)" = "Darwin" ] || { echo "E.V runs on macOS."; exit 1; }
[ "$(uname -m)" = "arm64" ] || { echo "E.V needs an Apple silicon Mac (M1 or newer)."; exit 1; }
[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 14 ] || { echo "E.V needs macOS 14 (Sonoma) or newer."; exit 1; }

echo "Installing E.V…"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fL --progress-bar -o "$TMP/E.V.zip" "${EV_URL:-https://github.com/$REPO/releases/latest/download/E.V.zip}"
ditto -xk "$TMP/E.V.zip" "$TMP/app"

DEST="${EV_DEST:-/Applications}"
[ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
osascript -e 'quit app id "com.ducknac.ev"' >/dev/null 2>&1 || true
rm -rf "$DEST/E.V.app"
ditto "$TMP/app/E.V.app" "$DEST/E.V.app"
xattr -dr com.apple.quarantine "$DEST/E.V.app" 2>/dev/null || true

[ -n "${EV_NO_OPEN:-}" ] || open "$DEST/E.V.app"
echo "Done. E.V is in $DEST and opening now."
