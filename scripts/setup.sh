#!/usr/bin/env bash
# One-time setup of a Google Cloud / Firebase project for Readlater, then a first deploy.
# Safe to re-run: every step checks what already exists.
#
#   scripts/setup.sh [--project <id>] [--location <firestore location>] [--yes]
#
# Needs: Node.js 22+, npm, the Google Cloud CLI (gcloud), curl. firebase-tools comes from the repo
# (npm ci at the repo root) unless a global `firebase` exists.
# Non-interactive use (no TTY or --yes): defaults are taken; set PROJECT_ID / FIRESTORE_LOCATION /
# STORAGE_LOCATION to override them, and READLATER_ANTHROPIC_API_KEY / READLATER_TELEGRAM_BOT_TOKEN /
# READLATER_INBOUND_EMAIL_DOMAIN to switch on the optional integrations (all skipped otherwise).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${PROJECT_ID:-}"
FS_LOCATION="${FIRESTORE_LOCATION:-}"
ST_LOCATION="${STORAGE_LOCATION:-}"
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project|-p) PROJECT="${2:?--project needs a value}"; shift 2 ;;
    --location) FS_LOCATION="${2:?--location needs a value}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

INTERACTIVE=1
if [[ ! -t 0 || "$ASSUME_YES" -eq 1 ]]; then INTERACTIVE=0; fi

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
say() { printf '\n'; bold "==> $*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    ! %s\n' "$*" >&2; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }

# ask <prompt> <default> -> echoes the answer (default when non-interactive or empty)
ask() {
  local prompt="$1" def="${2:-}" ans=""
  if [[ "$INTERACTIVE" -eq 1 ]]; then
    read -r -p "    $prompt${def:+ [$def]}: " ans </dev/tty || true
  fi
  printf '%s' "${ans:-$def}"
}
# confirm <prompt> <default y|n>
confirm() {
  local ans
  ans="$(ask "$1 (y/n)" "${2:-n}")"
  [[ "$ans" =~ ^[Yy] ]]
}
# ask_secret <prompt> -> echoes the value (hidden input); empty when non-interactive
ask_secret() {
  local ans=""
  if [[ "$INTERACTIVE" -eq 1 ]]; then
    read -r -s -p "    $1: " ans </dev/tty || true
    printf '\n' >&2
  fi
  printf '%s' "$ans"
}
pause() {
  if [[ "$INTERACTIVE" -eq 1 ]]; then
    read -r -p "    ${1:-Press Enter to continue…}" _ </dev/tty || true
  fi
}

# ---------------------------------------------------------------------------
say "Checking tools"
command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node.js 22 (https://nodejs.org) and retry."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 22 ]] || warn "Node.js $NODE_MAJOR found; Node.js 22 is recommended (Cloud Functions run on Node 22)."
command -v npm >/dev/null 2>&1 || die "npm not found."
command -v curl >/dev/null 2>&1 || die "curl not found."
command -v gcloud >/dev/null 2>&1 || die "Google Cloud CLI (gcloud) not found. Install it: https://cloud.google.com/sdk/docs/install"
if [[ -x "$ROOT/node_modules/.bin/firebase" ]]; then
  FIREBASE=("$ROOT/node_modules/.bin/firebase")
elif command -v firebase >/dev/null 2>&1; then
  FIREBASE=(firebase)
else
  info "Installing firebase-tools (repo devDependency)…"
  (cd "$ROOT" && npm ci --no-audit --no-fund)
  FIREBASE=("$ROOT/node_modules/.bin/firebase")
fi
info "node $(node -v), $(gcloud --version 2>/dev/null | head -1), firebase-tools $("${FIREBASE[@]}" --version)"

# ---------------------------------------------------------------------------
say "Signing in"
if [[ -z "$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null)" ]]; then
  info "Opening the Google Cloud sign-in…"
  gcloud auth login
fi
GACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -1)"
info "gcloud: $GACCOUNT"
if ! "${FIREBASE[@]}" projects:list --json >/dev/null 2>&1; then
  info "Opening the Firebase sign-in…"
  "${FIREBASE[@]}" login
fi
"${FIREBASE[@]}" projects:list --json >/dev/null 2>&1 || die "The Firebase CLI is not signed in (run: ${FIREBASE[*]} login)."
info "firebase: signed in"

token() { gcloud auth print-access-token; }
# api <METHOD> <url> [json body] -> prints body, returns non-zero on HTTP >= 400
api() {
  local method="$1" url="$2" body="${3:-}" out code
  out="$(mktemp)"
  if [[ -n "$body" ]]; then
    code="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" -H "Authorization: Bearer $(token)" \
      -H "x-goog-user-project: $PROJECT" -H 'Content-Type: application/json' --data "$body" "$url")" || code=000
  else
    code="$(curl -sS -o "$out" -w '%{http_code}' -X "$method" -H "Authorization: Bearer $(token)" \
      -H "x-goog-user-project: $PROJECT" "$url")" || code=000
  fi
  cat "$out"
  rm -f "$out"
  [[ "$code" -lt 400 && "$code" != 000 ]]
}

# ---------------------------------------------------------------------------
say "Project"
if [[ -z "$PROJECT" && -f "$ROOT/.firebaserc" ]]; then
  CUR="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((r.projects&&r.projects.default)||"")' "$ROOT/.firebaserc")"
  [[ "$CUR" == demo-* ]] || PROJECT="$CUR"
fi
if [[ -z "$PROJECT" ]]; then
  SUFFIX="$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 6 || true)"
  info "Enter an existing project id, or a new one to create (6–30 chars: lowercase letters, digits, hyphens)."
  PROJECT="$(ask "Project id" "readlater-$SUFFIX")"
fi
[[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "Invalid project id: $PROJECT"
[[ "$PROJECT" != demo-* ]] || die "Project ids starting with demo- are reserved for the emulators."

if gcloud projects describe "$PROJECT" --format='value(projectId)' >/dev/null 2>&1; then
  info "Using existing Google Cloud project $PROJECT"
else
  info "Creating project $PROJECT (Google Cloud + Firebase)…"
  "${FIREBASE[@]}" projects:create "$PROJECT" --display-name "Readlater" ||
    die "Could not create the project. The id may be taken — re-run with another id."
fi
# Note: write ${VAR} (with braces) before non-ASCII text such as "…": macOS's bash 3.2 otherwise reads the
# first byte of the character as part of the variable name and fails under `set -u`.
firebase_has_project() {
  "${FIREBASE[@]}" projects:list --json | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s.slice(s.indexOf("{"))).result||[];
    process.exit(r.some(p=>p.projectId===process.argv[1])?0:1)})' "$PROJECT"
}
# A project created a moment ago can take a little while to show up in the Firebase project list.
for _ in 1 2 3 4 5 6; do firebase_has_project && break; sleep 5; done
if ! firebase_has_project; then
  info "Adding Firebase to ${PROJECT}…"
  "${FIREBASE[@]}" projects:addfirebase "$PROJECT" || firebase_has_project ||
    die "Could not add Firebase to $PROJECT. Add it in https://console.firebase.google.com (Add project → pick $PROJECT), then re-run."
fi
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
info "Project $PROJECT (number $PROJECT_NUMBER)"

# ---------------------------------------------------------------------------
say "Billing (Blaze plan)"
billing_enabled() {
  [[ "$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null)" == "True" ]]
}
if billing_enabled; then
  info "Billing is enabled."
else
  info "Cloud Functions need the pay-as-you-go Blaze plan (a personal Readlater stays within the free quotas)."
  ACCOUNTS="$(gcloud billing accounts list --filter='open=true' --format='value(name,displayName)' 2>/dev/null || true)"
  if [[ -n "$ACCOUNTS" ]]; then
    info "Billing accounts you can use:"
    printf '%s\n' "$ACCOUNTS" | sed 's/^/      /'
    ACC="$(ask "Billing account to link (empty = do it in the console)" "$(printf '%s\n' "$ACCOUNTS" | head -1 | cut -f1)")"
    if [[ -n "$ACC" ]]; then
      gcloud billing projects link "$PROJECT" --billing-account="${ACC#billingAccounts/}" >/dev/null ||
        warn "Linking failed; use the console link below."
    fi
  fi
  until billing_enabled; do
    info "Upgrade to Blaze here: https://console.firebase.google.com/project/$PROJECT/usage/details"
    [[ "$INTERACTIVE" -eq 1 ]] || die "Billing is not enabled for $PROJECT."
    pause "Press Enter once the project is on the Blaze plan…"
  done
  info "Billing is enabled."
fi

# ---------------------------------------------------------------------------
say "Enabling Google Cloud APIs (takes a minute the first time)"
gcloud services enable --project "$PROJECT" \
  firestore.googleapis.com cloudfunctions.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com run.googleapis.com eventarc.googleapis.com pubsub.googleapis.com \
  cloudscheduler.googleapis.com storage.googleapis.com iamcredentials.googleapis.com \
  identitytoolkit.googleapis.com firebasestorage.googleapis.com firebaserules.googleapis.com \
  firebasehosting.googleapis.com secretmanager.googleapis.com compute.googleapis.com \
  cloudresourcemanager.googleapis.com serviceusage.googleapis.com iam.googleapis.com
info "APIs enabled."

# ---------------------------------------------------------------------------
say "Firestore"
if gcloud firestore databases describe --database='(default)' --project "$PROJECT" >/dev/null 2>&1; then
  info "Database (default) exists ($(gcloud firestore databases describe --database='(default)' --project "$PROJECT" --format='value(locationId)'))."
else
  FS_RE='^([a-z]+[0-9]|[a-z]+-[a-z]+[0-9]+)$'
  until [[ "$FS_LOCATION" =~ $FS_RE ]]; do
    [[ -z "$FS_LOCATION" ]] || warn "\"$FS_LOCATION\" is not a location id (examples: nam5, eur3, europe-west1)."
    [[ "$INTERACTIVE" -eq 1 || -z "$FS_LOCATION" ]] || die "Invalid FIRESTORE_LOCATION."
    FS_LOCATION="$(ask "Firestore location (nam5 = US multi-region, eur3 = Europe, or a region like europe-west1)" "nam5")"
  done
  gcloud firestore databases create --database='(default)' --location="$FS_LOCATION" --type=firestore-native --project "$PROJECT"
fi
# The same TTL policies are in firestore.indexes.json, so `firebase deploy --force` keeps them.
for cg in loginCodes rateLimits telegramLinks telegramUpdates emailDedupe feedSeen; do
  if gcloud firestore fields ttls list --database='(default)' --collection-group="$cg" --project "$PROJECT" --format='value(ttlConfig.state)' 2>/dev/null | grep -qE 'ACTIVE|CREATING'; then
    info "TTL on $cg.expiresAt already set."
  else
    gcloud firestore fields ttls update expiresAt --database='(default)' --collection-group="$cg" --enable-ttl --async --quiet --project "$PROJECT" >/dev/null &&
      info "TTL on $cg.expiresAt requested." || warn "Could not set the TTL policy on $cg.expiresAt (expired docs then stay until deleted)."
  fi
done

# ---------------------------------------------------------------------------
say "Cloud Storage"
BUCKETS="$(api GET "https://firebasestorage.googleapis.com/v1beta/projects/$PROJECT/buckets" 2>/dev/null || true)"
if printf '%s' "$BUCKETS" | grep -qE "\"projects/$PROJECT/buckets/$PROJECT\.(firebasestorage\.app|appspot\.com)\""; then
  info "Default bucket exists."
else
  ST_RE='^([a-z]+-[a-z]+[0-9]+|us|eu|asia)$'
  until [[ "$ST_LOCATION" =~ $ST_RE ]]; do
    [[ -z "$ST_LOCATION" ]] || warn "\"$ST_LOCATION\" is not a location id (examples: us-central1, europe-west1)."
    [[ "$INTERACTIVE" -eq 1 || -z "$ST_LOCATION" ]] || die "Invalid STORAGE_LOCATION."
    ST_LOCATION="$(ask "Storage location (us-central1, us-east1 and us-west1 have a free tier)" "us-central1")"
  done
  if api POST "https://firebasestorage.googleapis.com/v1alpha/projects/$PROJECT/defaultBucket" \
      "{\"location\":\"$(printf '%s' "$ST_LOCATION" | tr '[:lower:]' '[:upper:]')\"}" >/dev/null; then
    info "Created the default bucket."
  else
    warn "Could not create the default bucket automatically."
    info "Open https://console.firebase.google.com/project/$PROJECT/storage → Get started → production mode → $ST_LOCATION."
    [[ "$INTERACTIVE" -eq 1 ]] && pause "Press Enter when the bucket exists…"
  fi
fi

# ---------------------------------------------------------------------------
say "Service account permissions"
COMPUTE_SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"
for _ in $(seq 1 24); do
  gcloud iam service-accounts describe "$COMPUTE_SA" --project "$PROJECT" >/dev/null 2>&1 && break
  info "Waiting for the default compute service account to appear…"
  sleep 5
done
gcloud iam service-accounts describe "$COMPUTE_SA" --project "$PROJECT" >/dev/null 2>&1 ||
  die "The default compute service account $COMPUTE_SA does not exist (is the Compute Engine API enabled?)."
# createCustomToken (login codes) signs with the runtime service account itself.
gcloud iam service-accounts add-iam-policy-binding "$COMPUTE_SA" --project "$PROJECT" \
  --member="serviceAccount:$COMPUTE_SA" --role=roles/iam.serviceAccountTokenCreator --condition=None --quiet >/dev/null
info "$COMPUTE_SA can sign tokens."
# Newer projects no longer give the default service account the Editor role; grant what the
# functions (runtime) and Cloud Build (function builds) need. Idempotent.
for role in roles/cloudbuild.builds.builder roles/datastore.user roles/storage.objectAdmin \
            roles/eventarc.eventReceiver roles/logging.logWriter roles/firebaseauth.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$COMPUTE_SA" --role="$role" \
    --condition=None --quiet >/dev/null && info "granted $role" || warn "could not grant $role"
done

# ---------------------------------------------------------------------------
say "Authentication"
GOOGLE_IDP="$(api GET "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT/defaultSupportedIdpConfigs/google.com" 2>/dev/null || true)"
if printf '%s' "$GOOGLE_IDP" | grep -q '"enabled": *true'; then
  info "Google sign-in is enabled."
else
  info "Enable Google sign-in (there is no stable CLI for this — it needs an OAuth client the console creates):"
  info "  1. Open https://console.firebase.google.com/project/$PROJECT/authentication/providers"
  info "  2. Click 'Get started' if shown, then 'Google' → Enable → pick a support email → Save."
  info "  Authorized domains already include $PROJECT.web.app and $PROJECT.firebaseapp.com."
  pause "Press Enter when Google sign-in is enabled…"
fi

# ---------------------------------------------------------------------------
say "Web app config"
APP_ID="$("${FIREBASE[@]}" apps:list WEB --project "$PROJECT" --json | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s.slice(s.indexOf("{"))).result||[];process.stdout.write(r[0]?r[0].appId:"")})')"
if [[ -z "$APP_ID" ]]; then
  "${FIREBASE[@]}" apps:create WEB "Readlater" --project "$PROJECT" >/dev/null
  APP_ID="$("${FIREBASE[@]}" apps:list WEB --project "$PROJECT" --json | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s.slice(s.indexOf("{"))).result||[];process.stdout.write(r[0]?r[0].appId:"")})')"
fi
[[ -n "$APP_ID" ]] || die "Could not create or find the Firebase web app."
info "Web app $APP_ID"
CONFIG_JSON="$("${FIREBASE[@]}" apps:sdkconfig WEB "$APP_ID" --project "$PROJECT" --json | node "$ROOT/scripts/sdkconfig.mjs")"
[[ -n "$CONFIG_JSON" ]] || die "Could not read the web app config."
ENV_FILE="$ROOT/web/.env.production"
{
  echo "# Written by scripts/setup.sh for project $PROJECT"
  echo "VITE_FIREBASE_CONFIG='$CONFIG_JSON'"
  echo "VITE_PUBLIC_URL=https://$PROJECT.web.app"
} > "$ENV_FILE"
info "Wrote web/.env.production"
node -e '
  const fs=require("fs");const f=process.argv[1];let r={};
  try{r=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}
  r.projects=Object.assign({},r.projects,{default:process.argv[2],demo:"demo-readlater"});
  fs.writeFileSync(f,JSON.stringify(r,null,2)+"\n");' "$ROOT/.firebaserc" "$PROJECT"
info "Wrote .firebaserc (default: $PROJECT; emulators keep using demo-readlater)"

# ---------------------------------------------------------------------------
say "Optional integrations (AI, Telegram bot, email newsletters)"
# Plain settings go to functions/.env.<project> (git-ignored, read by `firebase deploy` and by the functions at
# runtime); secrets go to Cloud Secret Manager. A secret is bound to the functions only while its feature flag
# is in that file (AI_ENABLED, TELEGRAM_BOT_USERNAME, INBOUND_EMAIL_DOMAIN — see functions/src/integrations.ts),
# so a skipped or switched-off integration never blocks a deploy.
FUNCTIONS_ENV="$ROOT/functions/.env.$PROJECT"
secret_exists() { gcloud secrets describe "$1" --project "$PROJECT" >/dev/null 2>&1; }
set_secret() { printf '%s' "$2" | "${FIREBASE[@]}" functions:secrets:set "$1" --data-file=- --project "$PROJECT" --force >/dev/null; }
read_secret() { { "${FIREBASE[@]}" functions:secrets:access "$1" --project "$PROJECT" 2>/dev/null || true; } | tr -d '\r\n'; }
env_get() { [[ -f "$FUNCTIONS_ENV" ]] && sed -n "s/^$1=//p" "$FUNCTIONS_ENV" | tail -1 || true; }
env_unset() {
  [[ -f "$FUNCTIONS_ENV" ]] || return 0
  grep -v "^$1=" "$FUNCTIONS_ENV" > "$FUNCTIONS_ENV.tmp" || true
  mv "$FUNCTIONS_ENV.tmp" "$FUNCTIONS_ENV"
}
env_set() {
  if [[ ! -f "$FUNCTIONS_ENV" ]]; then
    {
      echo "# Cloud Functions settings for $PROJECT, written by scripts/setup.sh (git-ignored)."
      echo "# Secrets are not stored here: they live in Secret Manager (firebase functions:secrets:*)."
    } > "$FUNCTIONS_ENV"
  fi
  env_unset "$1"
  echo "$1=$2" >> "$FUNCTIONS_ENV"
}
random_secret() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40 || true; }
# telegram_username <bot token> -> the bot's username (empty if Telegram rejects the token)
telegram_username() {
  { curl -sS --max-time 20 "https://api.telegram.org/bot$1/getMe" 2>/dev/null || true; } | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);process.stdout.write(r.ok&&r.result.username||"")}catch{}})'
}
integration_status() {
  local ai tg em
  ai="off"; [[ "$(env_get AI_ENABLED)" == "1" ]] && ai="on"
  tg="$(env_get TELEGRAM_BOT_USERNAME)"; tg="${tg:+@$tg}"
  em="$(env_get INBOUND_EMAIL_DOMAIN)"
  info "AI (summaries, Q&A, tag suggestions): $ai"
  info "Telegram bot: ${tg:-off}"
  info "Email newsletters: ${em:-off}"
}

setup_ai() {
  local key="${READLATER_ANTHROPIC_API_KEY:-}"
  if [[ "$INTERACTIVE" -eq 1 ]]; then
    if secret_exists ANTHROPIC_API_KEY; then
      if [[ "$(env_get AI_ENABLED)" == "1" ]]; then
        if ! confirm "Keep AI features on?" y; then env_unset AI_ENABLED; info "AI turned off (the key stays in Secret Manager)."; return; fi
        confirm "Replace the stored Anthropic API key?" n || return 0
      elif ! confirm "An Anthropic API key is stored. Turn AI features on?" y; then
        return 0
      fi
    fi
    if [[ -z "$key" ]] && ! { secret_exists ANTHROPIC_API_KEY && [[ "$(env_get AI_ENABLED)" != "1" ]]; }; then
      info "AI summaries, questions about a document and tag suggestions use the Anthropic API"
      info "(key from https://console.anthropic.com/settings/keys; usage is billed by Anthropic)."
      key="$(ask_secret "Anthropic API key (empty = skip)")"
      [[ -n "$key" ]] || { info "AI: skipped."; return 0; }
    fi
  fi
  if [[ -n "$key" ]]; then
    [[ "$key" == sk-ant-* ]] || warn "That does not look like an Anthropic API key (sk-ant-…); saving it anyway."
    set_secret ANTHROPIC_API_KEY "$key"
    info "Saved ANTHROPIC_API_KEY in Secret Manager."
  fi
  if secret_exists ANTHROPIC_API_KEY; then
    env_set AI_ENABLED 1
    info "AI: on."
  fi
}

setup_telegram() {
  local token="${READLATER_TELEGRAM_BOT_TOKEN:-}" bot cur
  cur="$(env_get TELEGRAM_BOT_USERNAME)"
  if [[ "$INTERACTIVE" -eq 1 ]]; then
    if [[ -n "$cur" ]] && secret_exists TELEGRAM_BOT_TOKEN; then
      if ! confirm "Keep the Telegram bot @$cur?" y; then env_unset TELEGRAM_BOT_USERNAME; info "Telegram turned off (the token stays in Secret Manager)."; return; fi
      confirm "Replace the bot token?" n || return 0
    fi
    if [[ -z "$token" ]]; then
      info "Telegram: in Telegram talk to @BotFather → /newbot, then paste the token it gives you."
      token="$(ask_secret "Telegram bot token (empty = skip)")"
    fi
    if [[ -z "$token" ]] && [[ -z "$cur" ]] && secret_exists TELEGRAM_BOT_TOKEN && confirm "A bot token is stored. Turn the Telegram bot on with it?" y; then
      token="$(read_secret TELEGRAM_BOT_TOKEN)"
    fi
  fi
  [[ -n "$token" ]] || { [[ -n "$cur" ]] || info "Telegram: skipped."; return 0; }
  bot="$(telegram_username "$token")"
  if [[ -z "$bot" ]]; then
    warn "Telegram did not accept that token (or could not be reached); the bot was not set up."
    return 0
  fi
  [[ "$token" == "$(secret_exists TELEGRAM_BOT_TOKEN && read_secret TELEGRAM_BOT_TOKEN)" ]] || set_secret TELEGRAM_BOT_TOKEN "$token"
  secret_exists TELEGRAM_WEBHOOK_SECRET || set_secret TELEGRAM_WEBHOOK_SECRET "$(random_secret)"
  env_set TELEGRAM_BOT_USERNAME "$bot"
  info "Telegram bot: @$bot (the webhook is registered after the deploy)."
}

setup_email() {
  local cur dom
  cur="$(env_get INBOUND_EMAIL_DOMAIN)"
  dom="${READLATER_INBOUND_EMAIL_DOMAIN:-$cur}"
  if [[ "$INTERACTIVE" -eq 1 ]]; then
    info "Email newsletters: each user gets an address <token>@<domain>; the domain's mail is handed to the"
    info "inboundEmail function by Cloudflare Email Routing, Mailgun or SendGrid (integrations/cloudflare-email-worker)."
    dom="$(ask "Inbound email domain, e.g. in.example.com (empty = skip${cur:+, 'off' = turn off})" "$cur")"
  fi
  dom="$(printf '%s' "$dom" | tr '[:upper:]' '[:lower:]' | sed 's/^@//')"
  if [[ "$dom" == "off" ]]; then env_unset INBOUND_EMAIL_DOMAIN; info "Email newsletters turned off."; return 0; fi
  [[ -n "$dom" ]] || { info "Email newsletters: skipped."; return 0; }
  if [[ ! "$dom" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
    warn "\"$dom\" is not a domain name; email newsletters were not set up."
    return 0
  fi
  secret_exists INBOUND_EMAIL_SECRET || set_secret INBOUND_EMAIL_SECRET "$(random_secret)"
  env_set INBOUND_EMAIL_DOMAIN "$dom"
  info "Email newsletters: *@$dom → https://$REGION-$PROJECT.cloudfunctions.net/inboundEmail"
  info "Webhook secret (X-Readlater-Secret header or ?secret=): ${FIREBASE[*]} functions:secrets:access INBOUND_EMAIL_SECRET --project $PROJECT"
  info "Mail routing setup: integrations/cloudflare-email-worker/README.md"
}

REGION="us-central1"
integration_status
if [[ "$INTERACTIVE" -eq 1 ]]; then
  if confirm "Set up or change optional integrations now? (you can re-run this script later)" n; then
    setup_ai
    setup_telegram
    setup_email
    integration_status
  else
    info "Unchanged."
  fi
elif [[ -n "${READLATER_ANTHROPIC_API_KEY:-}${READLATER_TELEGRAM_BOT_TOKEN:-}${READLATER_INBOUND_EMAIL_DOMAIN:-}" ]]; then
  [[ -z "${READLATER_ANTHROPIC_API_KEY:-}" ]] || setup_ai
  [[ -z "${READLATER_TELEGRAM_BOT_TOKEN:-}" ]] || setup_telegram
  [[ -z "${READLATER_INBOUND_EMAIL_DOMAIN:-}" ]] || setup_email
  integration_status
fi

# ---------------------------------------------------------------------------
say "First deploy"
FIREBASE_PROJECT="$PROJECT" "$ROOT/scripts/deploy.sh" --project "$PROJECT"

# ---------------------------------------------------------------------------
say "GitHub Actions deploys (optional)"
if [[ "$INTERACTIVE" -eq 1 ]] && confirm "Create a deploy service account key for GitHub Actions (secret FIREBASE_SERVICE_ACCOUNT)?" n; then
  DEPLOY_SA="readlater-deployer@$PROJECT.iam.gserviceaccount.com"
  gcloud iam service-accounts describe "$DEPLOY_SA" --project "$PROJECT" >/dev/null 2>&1 ||
    gcloud iam service-accounts create readlater-deployer --display-name "Readlater deploy (GitHub Actions)" --project "$PROJECT"
  for role in roles/firebase.admin roles/cloudfunctions.admin roles/run.admin roles/iam.serviceAccountUser \
              roles/artifactregistry.admin roles/cloudscheduler.admin roles/eventarc.admin roles/pubsub.admin \
              roles/secretmanager.admin roles/serviceusage.serviceUsageAdmin roles/cloudbuild.builds.editor \
              roles/storage.admin roles/datastore.indexAdmin; do
    gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$DEPLOY_SA" --role="$role" \
      --condition=None --quiet >/dev/null || warn "could not grant $role"
  done
  KEY_FILE="$ROOT/service-account-$PROJECT.json"
  if gcloud iam service-accounts keys create "$KEY_FILE" --iam-account="$DEPLOY_SA" --project "$PROJECT"; then
    chmod 600 "$KEY_FILE"
    if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 && (cd "$ROOT" && gh repo view >/dev/null 2>&1); then
      (cd "$ROOT" && gh secret set FIREBASE_SERVICE_ACCOUNT < "$KEY_FILE" && gh variable set FIREBASE_PROJECT_ID --body "$PROJECT")
      rm -f "$KEY_FILE"
      info "Saved the GitHub secret FIREBASE_SERVICE_ACCOUNT and variable FIREBASE_PROJECT_ID."
    else
      info "Key written to $KEY_FILE (git-ignored). Add its contents as the repository secret"
      info "FIREBASE_SERVICE_ACCOUNT and add a variable FIREBASE_PROJECT_ID=$PROJECT, then delete the file."
    fi
  else
    warn "Key creation failed (an organization policy may forbid service account keys)."
  fi
fi

# The deploy workflow writes functions/.env.<project> from the FUNCTIONS_ENV variable, so deploys from
# GitHub Actions keep the optional integrations switched on. Only the known, non-secret settings are copied.
functions_env_vars() {
  [[ -f "$FUNCTIONS_ENV" ]] || return 0
  grep -E '^(AI_ENABLED|TELEGRAM_BOT_USERNAME|INBOUND_EMAIL_DOMAIN|PUBLIC_URL|ANTHROPIC_MODEL)=' "$FUNCTIONS_ENV" || true
}
FUNCTIONS_ENV_VARS="$(functions_env_vars)"
if [[ -n "$FUNCTIONS_ENV_VARS" ]]; then
  if [[ "$INTERACTIVE" -eq 1 ]] && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 && (cd "$ROOT" && gh repo view >/dev/null 2>&1); then
    if confirm "Copy the integration settings to the GitHub variable FUNCTIONS_ENV (for deploys from GitHub Actions)?" y; then
      (cd "$ROOT" && gh variable set FUNCTIONS_ENV --body "$FUNCTIONS_ENV_VARS") && info "Saved the GitHub variable FUNCTIONS_ENV."
    fi
  else
    info "For deploys from GitHub Actions, add a repository variable FUNCTIONS_ENV with these lines:"
    printf '%s\n' "$FUNCTIONS_ENV_VARS" | sed 's/^/      /'
  fi
fi

say "Done"
info "Web app:      https://$PROJECT.web.app"
info "Android APK:  scripts/build-android.sh   (see docs/NATIVE.md for installing on a Boox)"
info "Redeploy:     scripts/deploy.sh"
