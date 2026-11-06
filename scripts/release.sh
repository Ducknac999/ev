#!/bin/zsh
# Builds a signed E.V release and its downloads into release/<version>/:
#   E.V.zip (install command), E.V.dmg, E.V.app.tar.gz + latest.json (in-app updates).
# Needs: the "E.V Release Signing" certificate in the keychain, the update key at
# ~/.tauri/ev-updater.key, and dmgbuild (DMGBUILD=/path/to/dmgbuild).
# Publish with:  scripts/release.sh publish   (after reviewing release/<version>/)
set -euo pipefail
ROOT=${0:A:h:h}
cd "$ROOT"
REPO="Ducknac999/ev"
VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
OUT="$ROOT/release/$VERSION"
APP="$ROOT/src-tauri/target/release/bundle/macos/E.V.app"
DMGBUILD=${DMGBUILD:-dmgbuild}

if [[ "${1:-}" == "publish" ]]; then
  NOTES="$ROOT/release-notes/$VERSION.md"
  [[ -f "$NOTES" ]] || { print -u2 "Write $NOTES first (## Security / ## Features / ## UI / ## Fixes)."; exit 1; }
  gh release create "v$VERSION" --repo "$REPO" --title "E.V $VERSION" --notes-file "$NOTES" \
    "$OUT/E.V.zip" "$OUT/E.V.dmg" "$OUT/E.V.app.tar.gz" "$OUT/latest.json"
  exit 0
fi

# Builds never carry the builder's home folder (or username) in the app.
export RUSTFLAGS="--remap-path-prefix=$HOME=/build ${RUSTFLAGS:-}"
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/ev-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run helpers
codesign --force --sign "E.V Release Signing" src-tauri/resources/libgideoncapture.dylib
npx tauri build --bundles app
codesign --verify --deep --strict "$APP"
if strings "$APP/Contents/MacOS/ev" | grep -q "$HOME"; then print -u2 "✗ The app still contains $HOME — not releasing it."; exit 1; fi

rm -rf "$OUT"; mkdir -p "$OUT"
ditto -c -k --keepParent "$APP" "$OUT/E.V.zip"
cp "src-tauri/target/release/bundle/macos/E.V.app.tar.gz" "$OUT/E.V.app.tar.gz"
SIG=$(cat "src-tauri/target/release/bundle/macos/E.V.app.tar.gz.sig")
NOTE_TEXT=$( [[ -f "release-notes/$VERSION.md" ]] && cat "release-notes/$VERSION.md" || echo "E.V $VERSION" )
node -e '
const [v, sig, notes, repo] = process.argv.slice(1);
console.log(JSON.stringify({ version: v, notes, pub_date: new Date().toISOString(),
  platforms: { "darwin-aarch64": { signature: sig, url: `https://github.com/${repo}/releases/download/v${v}/E.V.app.tar.gz` } } }, null, 2));
' "$VERSION" "$SIG" "$NOTE_TEXT" "$REPO" > "$OUT/latest.json"

ART=$(mktemp -d)
"${DMGBUILD:h}/python" scripts/dmg-background.py "$ART" 2>/dev/null || python3 scripts/dmg-background.py "$ART"
"$DMGBUILD" -s scripts/dmg-settings.py -D app="$APP" -D art="$ART" "E.V" "$OUT/E.V.dmg"
rm -rf "$ART"
echo "Release $VERSION ready in $OUT"
ls -la "$OUT"
