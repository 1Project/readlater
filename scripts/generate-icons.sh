#!/usr/bin/env bash
# Regenerate PNG icons from the SVG sources:
#   web/resources/icon-light*.svg     -> Android legacy launcher icons (mipmap-*/ic_launcher*.png, API < 26)
#   web/resources/icon-ios.svg        -> iOS AppIcon 1024x1024 (opaque); the iOS launch image is plain white
# The Android adaptive icon (API 26+) is a vector drawable (res/drawable/ic_launcher_foreground.xml)
# drawn from the same bookmark glyph as web/resources/icon-foreground.svg.
#
# Needs a Chromium/Chrome binary (CHROME=/path/to/chrome, or found on PATH / in PLAYWRIGHT_BROWSERS_PATH)
# and ImageMagick (`convert` or `magick`) to crop the screenshots and drop the iOS icon's alpha channel.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="$ROOT/web"
RES="$WEB/android/app/src/main/res"
IOS_ICON="$WEB/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"

find_chrome() {
  if [[ -n "${CHROME:-}" ]]; then echo "$CHROME"; return; fi
  local c
  for c in chromium chromium-browser google-chrome google-chrome-stable chrome; do
    if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return; fi
  done
  local dir="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
  c="$(ls -d "$dir"/chromium-*/chrome-linux/chrome 2>/dev/null | sort -V | tail -1 || true)"
  if [[ -n "$c" ]]; then echo "$c"; return; fi
  c="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  if [[ -x "$c" ]]; then echo "$c"; return; fi
  echo "Chrome/Chromium not found; set CHROME=/path/to/chrome" >&2
  exit 1
}

CHROME_BIN="$(find_chrome)"
if command -v magick >/dev/null 2>&1; then IM=(magick); elif command -v convert >/dev/null 2>&1; then IM=(convert); else
  echo "ImageMagick (magick/convert) not found" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# render <svg> <size> <out.png> [opaque]
render() {
  local svg="$1" size="$2" out="$3" bg="00000000"
  [[ "${4:-}" == "opaque" ]] && bg="ffffffff"
  local html="$TMP/page.html"
  printf '<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}img{display:block;width:%spx;height:%spx}</style></head><body><img src="file://%s"></body></html>' \
    "$size" "$size" "$svg" > "$html"
  mkdir -p "$(dirname "$out")"
  # New headless Chrome reserves part of the window for (invisible) browser UI, so render into a
  # taller window and crop the top-left square.
  "$CHROME_BIN" --headless --disable-gpu --no-sandbox --hide-scrollbars --force-device-scale-factor=1 \
    --default-background-color="$bg" --window-size="$((size + 200)),$((size + 400))" --screenshot="$TMP/shot.png" \
    "file://$html" >/dev/null 2>&1
  if [[ "${4:-}" == "opaque" ]]; then
    "${IM[@]}" "$TMP/shot.png" -crop "${size}x${size}+0+0" +repage -background white -alpha remove -alpha off \
      -type TrueColor "PNG24:$out"
  else
    "${IM[@]}" "$TMP/shot.png" -crop "${size}x${size}+0+0" +repage "PNG32:$out"
  fi
  echo "  $out (${size}px)"
}

echo "PWA icons"
render "$WEB/public/icon.svg" 192 "$WEB/public/icon-192.png"
render "$WEB/public/icon.svg" 512 "$WEB/public/icon-512.png"

echo "Android legacy launcher icons"
for pair in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  d="${pair%%:*}"; s="${pair##*:}"
  render "$WEB/resources/icon-light.svg" "$s" "$RES/mipmap-$d/ic_launcher.png"
  render "$WEB/resources/icon-light-round.svg" "$s" "$RES/mipmap-$d/ic_launcher_round.png"
done

if [[ -d "$(dirname "$IOS_ICON")" ]]; then
  echo "iOS AppIcon + plain white launch image"
  render "$WEB/resources/icon-ios.svg" 1024 "$IOS_ICON" opaque
  SPLASH="$WEB/ios/App/App/Assets.xcassets/Splash.imageset"
  for f in splash-2732x2732.png splash-2732x2732-1.png splash-2732x2732-2.png; do
    "${IM[@]}" -size 2732x2732 xc:white -type TrueColor "PNG24:$SPLASH/$f"
    echo "  $SPLASH/$f"
  done
fi
echo "Done."
