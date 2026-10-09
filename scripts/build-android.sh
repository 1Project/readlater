#!/usr/bin/env bash
# Build the Readlater Android app (APK).
#
#   scripts/build-android.sh [--skip-web] [--release-only]
#
# Steps: check JDK 21 + Android SDK (installs missing SDK packages with sdkmanager when available),
# build the web app (web/dist, using web/.env.production for VITE_FIREBASE_CONFIG / VITE_PUBLIC_URL),
# `npx cap sync android`, then `./gradlew assembleDebug`.
#
# Release build: when READLATER_KEYSTORE (path to a .jks/.keystore), READLATER_KEYSTORE_PASSWORD and
# READLATER_KEY_ALIAS (optional READLATER_KEY_PASSWORD, defaults to the store password) are set, a
# signed `assembleRelease` is built too. READLATER_VERSION_CODE / READLATER_VERSION_NAME set the version.
#
# Environment: ANDROID_HOME / ANDROID_SDK_ROOT (else common default locations are tried).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB="$ROOT/web"
ANDROID="$WEB/android"

SKIP_WEB=0
RELEASE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --skip-web) SKIP_WEB=1 ;;
    --release-only) RELEASE_ONLY=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

# --- JDK -------------------------------------------------------------------
say "Checking Java"
command -v java >/dev/null 2>&1 || die "Java not found. Install JDK 21 (e.g. Temurin 21) and retry."
JAVA_MAJOR="$(java -XshowSettings:properties -version 2>&1 | awk -F'= ' '/java.specification.version/ {print $2}' | cut -d. -f1)"
[[ "${JAVA_MAJOR:-0}" -ge 21 ]] || die "JDK 21 or newer is required (found ${JAVA_MAJOR:-unknown}). Set JAVA_HOME to a JDK 21."
echo "Java $JAVA_MAJOR"

# --- Android SDK -------------------------------------------------------------
say "Checking Android SDK"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$SDK" ]]; then
  for d in "$HOME/Android/Sdk" "$HOME/Library/Android/sdk" /opt/android-sdk /usr/local/lib/android/sdk; do
    if [[ -d "$d" ]]; then SDK="$d"; break; fi
  done
fi
[[ -n "$SDK" && -d "$SDK" ]] || die "Android SDK not found. Install Android Studio (or the command-line tools) and set ANDROID_HOME.
  Command-line only: download commandlinetools-linux/mac from https://developer.android.com/studio#command-line-tools-only,
  unzip to \$ANDROID_HOME/cmdline-tools/latest, then re-run this script."
export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"
echo "SDK: $SDK"

COMPILE_SDK="$(sed -n 's/^[[:space:]]*compileSdkVersion[[:space:]]*=[[:space:]]*\([0-9]*\).*/\1/p' "$ANDROID/variables.gradle")"
BUILD_TOOLS="${READLATER_BUILD_TOOLS:-35.0.0}"
NEEDED=()
[[ -d "$SDK/platforms/android-$COMPILE_SDK" ]] || NEEDED+=("platforms;android-$COMPILE_SDK")
if ! ls -d "$SDK"/build-tools/* >/dev/null 2>&1; then NEEDED+=("build-tools;$BUILD_TOOLS"); fi
[[ -d "$SDK/platform-tools" ]] || NEEDED+=("platform-tools")
if [[ ${#NEEDED[@]} -gt 0 ]]; then
  SDKMANAGER=""
  for c in "$SDK/cmdline-tools/latest/bin/sdkmanager" "$SDK"/cmdline-tools/*/bin/sdkmanager "$(command -v sdkmanager || true)"; do
    if [[ -n "$c" && -x "$c" ]]; then SDKMANAGER="$c"; break; fi
  done
  [[ -n "$SDKMANAGER" ]] || die "Missing SDK packages (${NEEDED[*]}) and no sdkmanager found. Install them with Android Studio's SDK Manager."
  echo "Installing ${NEEDED[*]}"
  yes | "$SDKMANAGER" --sdk_root="$SDK" --licenses >/dev/null || true
  "$SDKMANAGER" --sdk_root="$SDK" "${NEEDED[@]}"
fi
if [[ ! -f "$ANDROID/local.properties" ]] || ! grep -q '^sdk.dir=' "$ANDROID/local.properties"; then
  echo "sdk.dir=$SDK" > "$ANDROID/local.properties"
fi

# --- Web build -----------------------------------------------------------------
cd "$WEB"
if [[ ! -d node_modules ]]; then
  say "Installing web dependencies"
  npm ci
fi
if [[ "$SKIP_WEB" -eq 0 ]]; then
  say "Building web app"
  if [[ -z "${VITE_FIREBASE_CONFIG:-}" && ! -f .env.production && ! -f .env.production.local ]]; then
    echo "Warning: no VITE_FIREBASE_CONFIG and no web/.env.production — the app will not know which Firebase project to use."
    echo "         Run scripts/setup.sh (writes web/.env.production) or export VITE_FIREBASE_CONFIG / VITE_PUBLIC_URL."
  fi
  npm run build
else
  [[ -f dist/index.html ]] || die "web/dist is missing; run without --skip-web."
fi

say "Syncing Capacitor (android)"
npx cap sync android

# --- Gradle ----------------------------------------------------------------------
cd "$ANDROID"
chmod +x gradlew
TASKS=()
[[ "$RELEASE_ONLY" -eq 1 ]] || TASKS+=(assembleDebug)
if [[ -n "${READLATER_KEYSTORE:-}" ]]; then
  [[ -f "$READLATER_KEYSTORE" ]] || die "READLATER_KEYSTORE does not exist: $READLATER_KEYSTORE"
  [[ -n "${READLATER_KEYSTORE_PASSWORD:-}" && -n "${READLATER_KEY_ALIAS:-}" ]] ||
    die "Set READLATER_KEYSTORE_PASSWORD and READLATER_KEY_ALIAS for the release build."
  READLATER_KEYSTORE="$(cd "$(dirname "$READLATER_KEYSTORE")" && pwd)/$(basename "$READLATER_KEYSTORE")"
  export READLATER_KEYSTORE
  TASKS+=(assembleRelease)
elif [[ "$RELEASE_ONLY" -eq 1 ]]; then
  die "--release-only needs READLATER_KEYSTORE, READLATER_KEYSTORE_PASSWORD and READLATER_KEY_ALIAS."
fi

say "Gradle ${TASKS[*]}"
./gradlew --no-daemon "${TASKS[@]}"

say "Done"
for apk in app/build/outputs/apk/debug/app-debug.apk app/build/outputs/apk/release/app-release.apk; do
  if [[ -f "$apk" ]]; then
    printf '%s  (%s)\n' "$ANDROID/$apk" "$(du -h "$apk" | cut -f1)"
  fi
done
echo "Install on a connected device:  adb install -r <apk>   (or copy the APK to the device; see docs/NATIVE.md)"
