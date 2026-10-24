#!/usr/bin/env bash
# Build and deploy Readlater to Firebase (Firestore rules/indexes, Storage rules, Cloud Functions, Hosting).
#
#   scripts/deploy.sh [--project <id>] [--only <targets>] [--skip-install]
#
# Project: --project, else $FIREBASE_PROJECT, else the "default" project in .firebaserc (not demo-*).
# Targets default to firestore,storage,functions,hosting.
# The web build uses web/.env.production (written by scripts/setup.sh) when present; without it the
# hosted app reads its Firebase config from /__/firebase/init.json, which Hosting serves automatically.
# Optional integrations are configured in functions/.env.<project> (scripts/setup.sh writes it); after a
# functions deploy with the Telegram bot switched on, the bot's webhook is (re-)registered.
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
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
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

# Optional integrations (AI, Telegram, email) are switched on by functions/.env.<project>, which setup.sh
# writes and git does not track. Without it the functions deploy with those features off.
if [[ ",$ONLY," == *",functions"* && ! -f "$ROOT/functions/.env.$PROJECT" && -z "${GITHUB_ACTIONS:-}" ]]; then
  echo
  echo "Warning: functions/.env.$PROJECT not found, so AI, the Telegram bot and email newsletters will be OFF"
  echo "after this deploy. To switch them on (keys already in Secret Manager are reused), run:"
  echo "  scripts/setup.sh --project $PROJECT"
  echo
fi

say "Deploying ($ONLY) to $PROJECT"
cd "$ROOT"
# --force: remove functions that no longer exist in the source and accept the default
# container-image cleanup policy instead of prompting.
# The first functions deploy on a new project often fails while Google Cloud finishes setting up service
# agents (Eventarc permissions, the function source bucket, Cloud Run): wait and retry a few times.
attempt=1
until "${FIREBASE[@]}" deploy --only "$ONLY" --project "$PROJECT" --force --non-interactive; do
  if [[ ",$ONLY," != *",functions"* || "$attempt" -ge 3 ]]; then
    echo
    echo "Deploy failed. If the errors mention permissions or 'An unexpected error occurred', wait a few"
    echo "minutes and run scripts/deploy.sh again; for build errors open the Cloud Build log link above."
    exit 1
  fi
  echo
  echo "Deploy attempt $attempt failed. A project's first functions deploy often fails while Google Cloud"
  echo "finishes setting up (Eventarc permissions, buckets, Cloud Run). Retrying in 2 minutes…"
  sleep 120
  attempt=$((attempt + 1))
done

# Telegram: point the bot at the deployed `telegram` function (idempotent; also sets the bot's command list).
# The function checks the webhook secret, so it is read from Secret Manager and sent as the header.
FUNCTIONS_ENV="$ROOT/functions/.env.$PROJECT"
if [[ ",$ONLY," == *",functions"* && -f "$FUNCTIONS_ENV" ]] && grep -qE '^TELEGRAM_BOT_USERNAME=.+' "$FUNCTIONS_ENV"; then
  say "Registering the Telegram webhook"
  TG_SECRET="$({ "${FIREBASE[@]}" functions:secrets:access TELEGRAM_WEBHOOK_SECRET --project "$PROJECT" 2>/dev/null || true; } | tr -d '\r\n')"
  if [[ -z "$TG_SECRET" ]]; then
    echo "Warning: could not read TELEGRAM_WEBHOOK_SECRET; run scripts/setup.sh to set up the Telegram bot." >&2
  else
    [[ -z "${GITHUB_ACTIONS:-}" ]] || echo "::add-mask::$TG_SECRET"
    TG_URL="https://us-central1-$PROJECT.cloudfunctions.net/telegram?action=setWebhook"
    TG_OUT=""
    for attempt in 1 2 3; do
      if TG_OUT="$(curl -sS --max-time 60 --fail-with-body -H "X-Telegram-Bot-Api-Secret-Token: $TG_SECRET" "$TG_URL" 2>&1)"; then
        echo "Webhook registered: $TG_OUT"
        break
      fi
      [[ "$attempt" -eq 3 ]] || { echo "Not ready yet ($TG_OUT); retrying in 20 seconds…"; sleep 20; }
    done
    [[ "$TG_OUT" == *'"ok":true'* ]] || echo "Warning: the Telegram webhook was not registered: $TG_OUT" >&2
  fi
fi

say "Deployed: https://$PROJECT.web.app"
