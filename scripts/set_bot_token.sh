#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="/Users/michaelbuttsworth/.openclaw/.env"
DEFAULT_API_BASE_URL="http://localhost:8000"

mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"

read -r -s -p "Enter TELEGRAM_BOT_TOKEN: " BOT_TOKEN
echo

if [[ -z "${BOT_TOKEN}" ]]; then
  echo "Error: token cannot be empty."
  exit 1
fi

if rg -q '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null; then
  sed -i '' "s|^TELEGRAM_BOT_TOKEN=.*$|TELEGRAM_BOT_TOKEN=${BOT_TOKEN}|" "$ENV_FILE"
else
  echo "TELEGRAM_BOT_TOKEN=${BOT_TOKEN}" >> "$ENV_FILE"
fi

if rg -q '^API_BASE_URL=' "$ENV_FILE" 2>/dev/null; then
  :
else
  echo "API_BASE_URL=${DEFAULT_API_BASE_URL}" >> "$ENV_FILE"
fi

echo "Updated $ENV_FILE"
echo "Set keys: TELEGRAM_BOT_TOKEN, API_BASE_URL"
