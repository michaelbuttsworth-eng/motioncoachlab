#!/usr/bin/env bash
set -euo pipefail

cd /Users/michaelbuttsworth/.openclaw/motioncoachlab
set -a
source /Users/michaelbuttsworth/.openclaw/.env
set +a

exec /Users/michaelbuttsworth/.openclaw/venvs/motioncoachlab/bin/python \
  /Users/michaelbuttsworth/.openclaw/motioncoachlab/services/bot/app/bot.py
