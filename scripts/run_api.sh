#!/usr/bin/env bash
set -euo pipefail

cd /Users/michaelbuttsworth/.openclaw/motioncoachlab
set -a
source /Users/michaelbuttsworth/.openclaw/.env
set +a

exec /Users/michaelbuttsworth/.openclaw/venvs/motioncoachlab/bin/uvicorn app.main:app \
  --app-dir /Users/michaelbuttsworth/.openclaw/motioncoachlab/services/api \
  --host 0.0.0.0 \
  --port 8000
