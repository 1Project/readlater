#!/usr/bin/env bash
# Build store-ready zips of the Readlater extension.
#   dist/readlater-extension.zip          Chrome Web Store / Edge Add-ons (background.service_worker only)
#   dist/readlater-extension-firefox.zip  addons.mozilla.org (background.scripts only)
# The unpacked folder itself (with both background keys) loads in Chrome 121+ and Firefox 128+.
set -euo pipefail
cd "$(dirname "$0")"

FILES=(manifest.json background.js lib.js popup.html popup.js popup.css options.html options.js options.css ui.css icons)

for f in "${FILES[@]}"; do [ -e "$f" ] || { echo "missing $f" >&2; exit 1; }; done
node -e 'JSON.parse(require("fs").readFileSync("manifest.json","utf8"))'
for f in *.js; do node --check "$f"; done

VERSION=$(node -p 'require("./manifest.json").version')
rm -rf dist && mkdir -p dist
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

build() { # $1 = chrome|firefox, $2 = zip name
  local dir="$STAGE/$1"
  mkdir -p "$dir"
  cp -R "${FILES[@]}" "$dir/"
  TARGET="$1" node -e '
    const fs = require("fs"), p = process.argv[1];
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    if (process.env.TARGET === "chrome") {
      m.background = { service_worker: "background.js" };
      delete m.browser_specific_settings;
    } else {
      m.background = { scripts: ["lib.js", "background.js"] };
    }
    fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
  ' "$dir/manifest.json"
  (cd "$dir" && zip -qr -X "$OLDPWD/dist/$2" .)
  echo "built dist/$2 ($1, v$VERSION)"
}

build chrome readlater-extension.zip
build firefox readlater-extension-firefox.zip
