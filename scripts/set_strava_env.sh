#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="/Users/michaelbuttsworth/.openclaw/.env"
DEFAULT_REDIRECT_URI="http://localhost:8000/strava/callback"

mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"

read -r -p "Enter STRAVA_CLIENT_ID: " STRAVA_CLIENT_ID
read -r -s -p "Enter STRAVA_CLIENT_SECRET: " STRAVA_CLIENT_SECRET
echo
read -r -p "Enter STRAVA_REDIRECT_URI [${DEFAULT_REDIRECT_URI}]: " STRAVA_REDIRECT_URI

if [[ -z "$STRAVA_CLIENT_ID" ]]; then
  echo "Error: STRAVA_CLIENT_ID cannot be empty"
  exit 1
fi

if [[ -z "$STRAVA_CLIENT_SECRET" ]]; then
  echo "Error: STRAVA_CLIENT_SECRET cannot be empty"
  exit 1
fi

if [[ -z "${STRAVA_REDIRECT_URI}" ]]; then
  STRAVA_REDIRECT_URI="$DEFAULT_REDIRECT_URI"
fi

upsert () {
  local key="$1"
  local val="$2"
  if rg -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i '' "s|^${key}=.*$|${key}=${val}|" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

upsert STRAVA_CLIENT_ID "$STRAVA_CLIENT_ID"
upsert STRAVA_CLIENT_SECRET "$STRAVA_CLIENT_SECRET"
upsert STRAVA_REDIRECT_URI "$STRAVA_REDIRECT_URI"

echo "Updated $ENV_FILE"
echo "Set keys: STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REDIRECT_URI"
