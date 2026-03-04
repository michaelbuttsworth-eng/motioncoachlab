import json
import os
import sys
from datetime import datetime

import httpx
from dotenv import load_dotenv

ENV_FILE = os.getenv("ENV_FILE")
if ENV_FILE:
    load_dotenv(ENV_FILE)

API_BASE_URL = os.getenv("API_BASE_URL", "http://localhost:8000")
BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")

if not BOT_TOKEN:
    sys.exit("TELEGRAM_BOT_TOKEN is required")


def log(msg: str) -> None:
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


def build_keyboard() -> dict:
    rows = [
        [{"text": "Mon", "callback_data": "wk:Mon"}],
        [{"text": "Tue", "callback_data": "wk:Tue"}],
        [{"text": "Wed", "callback_data": "wk:Wed"}],
        [{"text": "Thu", "callback_data": "wk:Thu"}],
        [{"text": "Fri", "callback_data": "wk:Fri"}],
        [{"text": "Sat", "callback_data": "wk:Sat"}],
        [{"text": "Sun", "callback_data": "wk:Sun"}],
        [{"text": "Done", "callback_data": "wk:Done"}],
    ]
    return {"inline_keyboard": rows}


def main() -> None:
    with httpx.Client(timeout=15) as client:
        try:
            resp = client.get(f"{API_BASE_URL}/users/telegram")
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            log(f"API unavailable at {API_BASE_URL}: {exc}")
            return
        users = resp.json()

        if not users:
            log("No users with telegram_id found.")
            return

        for user in users:
            chat_id = user.get("telegram_id")
            if not chat_id:
                continue

            payload = {
                "chat_id": chat_id,
                "text": "Weekly planning time — which days are off-limits this week?",
                "reply_markup": json.dumps(build_keyboard()),
            }
            try:
                r = client.post(
                    f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                    data=payload,
                )
            except httpx.HTTPError as exc:
                log(f"Telegram send error for {chat_id}: {exc}")
                continue
            if r.status_code >= 400:
                log(f"Failed to send to {chat_id}: {r.text}")
            else:
                log(f"Sent weekly prompt to {chat_id}")


if __name__ == "__main__":
    main()
