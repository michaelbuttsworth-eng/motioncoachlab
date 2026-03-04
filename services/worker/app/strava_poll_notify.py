#!/usr/bin/env python3
from __future__ import annotations

import os
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv

ENV_FILE = os.getenv("ENV_FILE", "/Users/michaelbuttsworth/.openclaw/.env")
if os.path.exists(ENV_FILE):
    load_dotenv(ENV_FILE)

API_BASE_URL = os.getenv("API_BASE_URL", "http://localhost:8000")
BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
INTERNAL_KEY = os.getenv("MOTIONCOACH_INTERNAL_API_KEY", "")


def log(msg: str) -> None:
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


def _headers() -> dict:
    return {"X-Internal-Key": INTERNAL_KEY} if INTERNAL_KEY else {}


def _latest_run(client: httpx.Client, user_id: int) -> dict | None:
    r = client.get(f"{API_BASE_URL}/runs/latest/{user_id}", headers=_headers())
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def _send_telegram(client: httpx.Client, chat_id: str, text: str) -> None:
    payload = {"chat_id": chat_id, "text": text}
    r = client.post(f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage", data=payload)
    if r.status_code >= 400:
        log(f"Telegram send failed for {chat_id}: {r.text}")


def _fmt_run(run: dict) -> str:
    if not run:
        return "No run details available."
    dist_km = round((run.get("distance_m", 0) or 0) / 1000.0, 2)
    dur_min = round((run.get("duration_s", 0) or 0) / 60.0, 1)
    pace = ""
    if dist_km > 0:
        pace = f"{round(dur_min / dist_km, 2)} min/km"
    start = _fmt_local_time(str(run.get("start_time", "")))
    return f"{dist_km} km in {dur_min} min ({pace}) at {start}"


def _fmt_local_time(raw: str) -> str:
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        local_dt = dt.astimezone(ZoneInfo("Australia/Sydney"))
        return local_dt.strftime("%a %d %b %Y, %-I:%M %p %Z")
    except Exception:
        return raw


def main() -> None:
    if not BOT_TOKEN:
        log("TELEGRAM_BOT_TOKEN missing; skipping poll")
        return

    with httpx.Client(timeout=20) as client:
        log("Starting Strava poll cycle")
        try:
            users_resp = client.get(f"{API_BASE_URL}/users/telegram")
            users_resp.raise_for_status()
            users = users_resp.json()
        except Exception as exc:
            log(f"Failed loading users: {exc}")
            return
        if not users:
            log("No telegram users found")
            return

        connected_count = 0
        for user in users:
            user_id = int(user.get("id"))
            chat_id = str(user.get("telegram_id") or "")
            if not chat_id:
                continue

            try:
                status = client.get(
                    f"{API_BASE_URL}/strava/status/{user_id}",
                    headers=_headers(),
                )
                status.raise_for_status()
                if not status.json().get("connected"):
                    continue
                connected_count += 1
            except Exception as exc:
                log(f"Status check failed for user {user_id}: {exc}")
                continue

            before = _latest_run(client, user_id)
            before_id = str(before.get("source_id")) if before else None

            try:
                sync = client.post(
                    f"{API_BASE_URL}/strava/sync/{user_id}",
                    json={},
                    headers=_headers(),
                )
                sync.raise_for_status()
                added = int(sync.json().get("added", 0))
            except Exception as exc:
                log(f"Sync failed for user {user_id}: {exc}")
                continue

            if added <= 0:
                continue

            after = _latest_run(client, user_id)
            after_id = str(after.get("source_id")) if after else None
            if before_id and after_id and before_id == after_id:
                # No net new latest run despite "added", avoid noisy duplicates.
                continue

            created = []
            try:
                params = {}
                if after and after.get("id"):
                    params["run_id"] = int(after.get("id"))
                ach = client.post(
                    f"{API_BASE_URL}/runs/achievements/check/{user_id}",
                    params=params,
                    json={},
                    headers=_headers(),
                )
                ach.raise_for_status()
                created = ach.json().get("created", []) or []
            except Exception:
                created = []

            msg = (
                f"Nice work — I imported {added} new run(s) from Strava.\n"
                f"Latest: {_fmt_run(after)}\n"
                "Ask me: what run do I have tomorrow?"
            )
            if created:
                lines = []
                for c in created[:3]:
                    lines.append(f"- {c.get('title')}: {c.get('detail')}")
                msg = f"{msg}\n\nAchievements:\n" + "\n".join(lines)
            _send_telegram(client, chat_id, msg)
            log(f"Notified user {user_id} ({chat_id}) for {added} new runs")
        if connected_count == 0:
            log("No connected Strava users this cycle")


if __name__ == "__main__":
    main()
