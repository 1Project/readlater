#!/usr/bin/env bash
# Build and deploy Readlater to Firebase (Firestore rules/indexes, Storage rules, Cloud Functions, Hosting).
#
#   scripts/deploy.sh [--project <id>] [--only <targets>] [--skip-install]
#
# Project: --project, else $FIREBASE_PROJECT, else the "default" project in .firebaserc (not demo-*).
# Targets default to firestore,storage,functions,hosting.
# The web build uses web/.env.production (written by scripts/setup.sh) when present; without it the
# hosted app reads its Firebase config from /__/firebase/init.json, which Hosting serves automatically.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${FIREBASE_PROJECT:-}"
ONLY="firestore,storage,functions,hosting"
SKIP_INSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project|-p) PROJECT="${2:?--project needs a value}"; shift 2 ;;
    --only) ONLY="${2:?--only needs a value}"; shift 2 ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

if [[ -z "$PROJECT" && -f "$ROOT/.firebaserc" ]]; then
  PROJECT="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((r.projects&&r.projects.default)||"")' "$ROOT/.firebaserc")"
fi
[[ -n "$PROJECT" && "$PROJECT" != demo-* ]] ||
  die "No Firebase project. Pass --project <id>, set FIREBASE_PROJECT, or run scripts/setup.sh first."

if [[ -x "$ROOT/node_modules/.bin/firebase" ]]; then
  FIREBASE=("$ROOT/node_modules/.bin/firebase")
elif command -v firebase >/dev/null 2>&1; then
  FIREBASE=(firebase)
else
  say "Installing firebase-tools (repo devDependency)"
  (cd "$ROOT" && npm ci)
  FIREBASE=("$ROOT/node_modules/.bin/firebase")
fi

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  say "Installing dependencies"
  (cd "$ROOT/functions" && npm ci)
  (cd "$ROOT/web" && npm ci)
fi

if [[ ",$ONLY," == *",functions,"* || ",$ONLY," == *",functions:"* ]]; then
  say "Building functions"
  (cd "$ROOT/functions" && npm run build)
fi

if [[ ",$ONLY," == *",hosting,"* ]]; then
  say "Building web app"
  if [[ ! -f "$ROOT/web/.env.production" && -z "${VITE_FIREBASE_CONFIG:-}" ]]; then
    echo "(no web/.env.production: the app will load its config from /__/firebase/init.json on Hosting)"
  fi
  (cd "$ROOT/web" && npm run build)
fi

say "Deploying ($ONLY) to $PROJECT"
cd "$ROOT"
# --force: remove functions that no longer exist in the source and accept the default
# container-image cleanup policy instead of prompting.
if ! "${FIREBASE[@]}" deploy --only "$ONLY" --project "$PROJECT" --force --non-interactive; then
  if [[ ",$ONLY," == *",functions"* ]]; then
    echo
    echo "Deploy failed. The first deploy of Firestore/Storage triggers often fails while Google Cloud"
    echo "finishes granting service-agent permissions. Retrying in 90 seconds…"
    sleep 90
    "${FIREBASE[@]}" deploy --only "$ONLY" --project "$PROJECT" --force --non-interactive
  else
    exit 1
  fi
fi

say "Deployed: https://$PROJECT.web.app"
