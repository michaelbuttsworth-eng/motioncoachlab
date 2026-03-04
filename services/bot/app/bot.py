import asyncio
import json
import os
import re
import time
from datetime import date, datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urlparse, parse_qs
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import (
    ApplicationBuilder,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

load_dotenv()

API_BASE_URL = os.getenv("API_BASE_URL", "http://localhost:8000")
BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
INTERNAL_API_KEY = os.getenv("MOTIONCOACH_INTERNAL_API_KEY", "")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

if not BOT_TOKEN:
    raise SystemExit("TELEGRAM_BOT_TOKEN is required")

ACTIVE_SESSIONS: dict[int, asyncio.Task] = {}
LAST_MENU_TS: dict[int, float] = {}


GOAL_MODE_OPTIONS = ["Prepare for an event", "Build up to run a distance continuously"]
GOAL_DISTANCE_OPTIONS = {
    "event": ["5K", "10K", "Half Marathon", "Marathon", "Ultra/Other"],
    "continuous": ["3K", "5K", "10K", "15K", "21.1K"],
}
GOAL_DATE_OPTIONS = ["In 4 weeks", "In 8 weeks", "In 12 weeks", "In 16 weeks", "Pick date"]
START_DATE_OPTIONS = ["Today", "Tomorrow", "Next Monday", "Pick date"]
WEEK_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

BASE_QUESTIONS = [
    (
        "Current ability?",
        ["New", "Occasional", "3x-week", "Experienced"],
        "ability_level",
    ),
    (
        "How many days can you run each week?",
        ["2", "3", "4", "5+"],
        "weekly_availability",
    ),
    (
        "Max time available per run?",
        ["Up to 30 min", "Up to 45 min", "Up to 60 min", "Up to 90 min", "Up to 120+ min"],
        "time_per_run",
    ),
    (
        "How long can you jog continuously today?",
        ["0-5 min", "5-10 min", "10-20 min", "20-30 min", "30+ min"],
        "continuous_run_min",
    ),
    (
        "How often have you run in the last 4 weeks?",
        ["0 days/week", "1 day/week", "2-3 days/week", "4+ days/week"],
        "recent_runs_per_week",
    ),
    (
        "In the last 4 weeks, what was your longest run/walk session?",
        ["Under 15 min", "15-30 min", "30-45 min", "45+ min"],
        "longest_recent_min",
    ),
    (
        "Are run/walk intervals okay for you?",
        ["Yes", "No"],
        "run_walk_ok",
    ),
    (
        "Injury or limitations?",
        ["None", "Returning", "Ongoing niggle"],
        "injury_status",
    ),
    (
        "Preferred run days? Tap days, then Done.",
        ["All Days", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Done"],
        "preferred_days",
    ),
]
TOTAL_ONBOARD_STEPS = 4 + len(BASE_QUESTIONS)

MONTHS = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}


def _week_start(today: date) -> date:
    return today - timedelta(days=today.weekday())


def _time_cap_minutes(value: str) -> int:
    text = (value or "").lower()
    if "120" in text:
        return 120
    if "90" in text:
        return 90
    if "60" in text:
        return 60
    if "45" in text:
        return 45
    if "30" in text:
        return 30
    return 60


def _feasibility_note(profile_like: dict) -> Optional[str]:
    goal = str(profile_like.get("goal_primary") or "").lower()
    days = int(profile_like.get("weekly_availability") or 0)
    cap = _time_cap_minutes(str(profile_like.get("time_per_run") or ""))
    timeline = profile_like.get("timeline_weeks")

    if "marathon" in goal and days <= 4 and cap <= 45:
        return (
            "Reality check: marathon prep is tight with your current setup.\n"
            f"- Current: {days} days/week, up to {cap} min/run.\n"
            "- Suggestion: increase one day to 90-120 min OR add a 5th run day OR extend timeline."
        )
    if "marathon" in goal and cap <= 60:
        return (
            "Heads up: marathon prep may need a longer weekly long-run window than your current cap.\n"
            f"- Current max: {cap} min/run.\n"
            "- Suggestion: allow one longer run day most weeks."
        )
    if "half" in goal and days <= 3 and cap <= 45:
        return (
            "Heads up: half marathon target is possible but tight with this time budget.\n"
            "- Suggestion: add one run day or extend timeline for lower injury risk."
        )
    if timeline and isinstance(timeline, int) and timeline <= 8 and ("marathon" in goal or "half" in goal):
        return "Heads up: your timeline is aggressive for this goal. We can still run a conservative finish-focused plan."
    continuous = int(profile_like.get("continuous_run_min") or 0)
    recent = int(profile_like.get("recent_runs_per_week") or 0)
    if continuous <= 10 or recent <= 1:
        return (
            "Great start. I will begin you on a Couch-to-5K style run/walk progression "
            "so early sessions are achievable."
        )
    return None


def _parse_mode(text: str) -> Optional[str]:
    t = text.strip().lower()
    if "always on" in t or t in {"mode always_on", "always_on"}:
        return "always_on"
    if "wake word" in t or "wake-word" in t or t in {"mode wake_word", "wake_word"}:
        return "wake_word"
    if "command only" in t or "command-only" in t or t in {"mode command_only", "command_only"}:
        return "command_only"
    return None


def _strip_wake_word(text: str) -> str:
    t = text.strip()
    lower = t.lower()
    if lower.startswith("coach,"):
        return t[6:].strip()
    if lower.startswith("coach "):
        return t[6:].strip()
    if lower.startswith("hey coach,"):
        return t[10:].strip()
    if lower.startswith("hey coach "):
        return t[10:].strip()
    return t


def _is_addressed(update: Update, bot_username: str) -> bool:
    if not update.message or not update.message.text:
        return False
    text = update.message.text
    lower = text.lower()
    uname = (bot_username or "").lower()
    if uname and f"@{uname}" in lower:
        return True
    if lower.startswith("coach") or lower.startswith("hey coach"):
        return True
    if update.message.reply_to_message and update.message.reply_to_message.from_user:
        return bool(update.message.reply_to_message.from_user.is_bot)
    return False


async def _get_engagement_mode(user_id: int) -> str:
    try:
        onboarding = await _api_get(f"/users/{user_id}/onboarding")
        mode = str(onboarding.get("engagement_mode") or "").strip().lower()
        if mode in {"always_on", "wake_word", "command_only"}:
            return mode
    except Exception:
        pass
    return "always_on"


async def _api_get(path: str):
    headers = {"X-Internal-Key": INTERNAL_API_KEY} if INTERNAL_API_KEY else {}
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(f"{API_BASE_URL}{path}", headers=headers)
        r.raise_for_status()
        return r.json()


async def _api_post(path: str, payload: dict):
    headers = {"X-Internal-Key": INTERNAL_API_KEY} if INTERNAL_API_KEY else {}
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(f"{API_BASE_URL}{path}", json=payload, headers=headers)
        r.raise_for_status()
        return r.json()


async def _create_manual_run_from_session(user_id: int, total_minutes: float) -> Optional[dict]:
    payload = {"duration_min": round(total_minutes, 1)}
    try:
        return await _api_post(f"/runs/manual/{user_id}", payload)
    except Exception:
        return None


async def _ensure_user(update: Update) -> dict:
    tg_user = update.effective_user
    telegram_id = str(tg_user.id)
    try:
        return await _api_get(f"/users/by-telegram/{telegram_id}")
    except httpx.HTTPStatusError:
        payload = {
            "name": tg_user.full_name or "Runner",
            "email": None,
            "telegram_id": telegram_id,
        }
        return await _api_post("/users/", payload)


def _question_keyboard(step: int, onboarding: Optional[dict] = None) -> InlineKeyboardMarkup:
    _, options, field = _onboarding_question(step, onboarding or {})
    if field == "preferred_days":
        rows = [
            [InlineKeyboardButton(text=day, callback_data=f"onbday:{step}:{day}")]
            for day in options[:-1]
        ]
        rows.append([InlineKeyboardButton(text="Done", callback_data=f"onbday:{step}:Done")])
        return InlineKeyboardMarkup(rows)
    if step == 1:
        rows = [[InlineKeyboardButton(text=opt, callback_data=f"onb:{step}:{opt}")] for opt in GOAL_MODE_OPTIONS]
        return InlineKeyboardMarkup(rows)
    rows = [
        [InlineKeyboardButton(text=opt, callback_data=f"onb:{step}:{opt}")]
        for opt in options
    ]
    return InlineKeyboardMarkup(rows)


def _goal_mode_key(value: str) -> str:
    return "event" if "event" in (value or "").lower() else "continuous"


def _onboarding_question(step: int, onboarding: dict) -> tuple[str, list[str], str]:
    if step == 1:
        return (
            "What are we training for?",
            GOAL_MODE_OPTIONS,
            "goal_mode",
        )
    if step == 2:
        mode = _goal_mode_key(str(onboarding.get("goal_mode") or ""))
        if mode == "event":
            return (
                "What event distance are you preparing for?",
                GOAL_DISTANCE_OPTIONS["event"],
                "goal_primary",
            )
        return (
            "What distance would you like to run continuously?",
            GOAL_DISTANCE_OPTIONS["continuous"],
            "goal_primary",
        )
    if step == 3:
        mode = _goal_mode_key(str(onboarding.get("goal_mode") or ""))
        if mode == "event":
            return (
                "When is your event date?",
                GOAL_DATE_OPTIONS,
                "goal_date",
            )
        return (
            "By what date would you like to run that distance continuously?",
            GOAL_DATE_OPTIONS,
            "goal_date",
        )
    if step == 4:
        return (
            "When do you want to start training?",
            START_DATE_OPTIONS,
            "start_date",
        )
    idx = step - 5
    return BASE_QUESTIONS[idx]


def _should_skip_step(step: int, onboarding: dict) -> bool:
    if step < 5:
        return False
    _, _, field = _onboarding_question(step, onboarding)
    # If user has not run recently, longest recent session question is redundant.
    if field == "longest_recent_min":
        recent = onboarding.get("recent_runs_per_week")
        try:
            return int(recent or 0) == 0
        except Exception:
            return False
    return False


def _home_menu_keyboard(strava_connected: bool, has_week_set: bool) -> InlineKeyboardMarkup:
    # Show one primary next action, not a large button block.
    if not strava_connected:
        return InlineKeyboardMarkup(
            [[InlineKeyboardButton(text="Connect Strava", callback_data="menu:connect_strava")]]
        )
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton(text="Start Today's Session", callback_data="menu:start_session")]]
    )


def _week_keyboard() -> InlineKeyboardMarkup:
    buttons = [
        [InlineKeyboardButton(text="Mon", callback_data="wk:Mon")],
        [InlineKeyboardButton(text="Tue", callback_data="wk:Tue")],
        [InlineKeyboardButton(text="Wed", callback_data="wk:Wed")],
        [InlineKeyboardButton(text="Thu", callback_data="wk:Thu")],
        [InlineKeyboardButton(text="Fri", callback_data="wk:Fri")],
        [InlineKeyboardButton(text="Sat", callback_data="wk:Sat")],
        [InlineKeyboardButton(text="Sun", callback_data="wk:Sun")],
        [InlineKeyboardButton(text="Done", callback_data="wk:Done")],
    ]
    return InlineKeyboardMarkup(buttons)


def _behavior_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton(text="Apply Suggestions", callback_data="beh:apply")],
            [InlineKeyboardButton(text="Skip for Now", callback_data="beh:skip")],
        ]
    )


def _week_capacity_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton(text="Keep Reduced Week", callback_data="wkc:keep")],
            [InlineKeyboardButton(text="Re-pick Days", callback_data="wkc:edit")],
        ]
    )


def _feedback_start_keyboard(run_id: int) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton(text="Post-run check-in", callback_data=f"fbstart:{run_id}")]]
    )


def _feedback_keyboard(run_id: int, stage: str) -> InlineKeyboardMarkup:
    if stage in {"effort", "fatigue", "pain"}:
        rows = []
        for row in ((1, 2, 3, 4, 5), (6, 7, 8, 9, 10)):
            rows.append(
                [
                    InlineKeyboardButton(text=str(v), callback_data=f"fb:{run_id}:{stage}:{v}")
                    for v in row
                ]
            )
        return InlineKeyboardMarkup(rows)
    opts = [("Too easy", "too_easy"), ("About right", "about_right"), ("Too hard", "too_hard")]
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton(text=label, callback_data=f"fb:{run_id}:{stage}:{value}")] for label, value in opts]
    )


def _onboarding_date_keyboard(field: str) -> InlineKeyboardMarkup:
    if field == "goal_date":
        return InlineKeyboardMarkup(
            [
                [InlineKeyboardButton(text="Use 12 weeks", callback_data="onbdate:goal_date:use12")],
                [InlineKeyboardButton(text="Back", callback_data="onbdate:goal_date:back")],
            ]
        )
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton(text="Back", callback_data=f"onbdate:{field}:back")]]
    )


def _onboarding_prompt(step: int, onboarding: dict) -> str:
    question, _, _ = _onboarding_question(step, onboarding)
    return f"Step {step}/{TOTAL_ONBOARD_STEPS}: {question}"


async def _send_set_week_prompt(target, user_id: int) -> None:
    wk = _week_start(date.today())
    try:
        week = await _api_get(f"/plans/week/{user_id}?week_start={wk.isoformat()}")
        target_km = int(week.get("target_km") or 0)
        motion_target = None
        run_days = 0
        for d in week.get("days", []):
            session = str(d.get("session_type") or "").lower()
            km = int(d.get("planned_km") or 0)
            notes = str(d.get("notes") or "")
            if session != "rest" and (km > 0 or notes.startswith("C25K|")):
                run_days += 1
            if notes.startswith("C25K|"):
                m = re.search(r"week_motion_min=([0-9]+(?:\\.[0-9]+)?)", notes)
                if m:
                    motion_target = int(float(m.group(1)))
        if motion_target:
            intro = (
                f"This week's target is {motion_target} minutes of motion across {run_days} run day(s).\n"
                "Which days are off-limits this week? Tap days, then Done."
            )
        else:
            intro = (
                f"This week you're scheduled for {target_km} km across {run_days} run day(s).\n"
                "Which days are off-limits this week? Tap days, then Done."
            )
    except Exception:
        intro = "Which days are off-limits this week? Tap days, then Done."
    await target.reply_text(intro, reply_markup=_week_keyboard())


async def _send_home_menu_message(target, user_id: Optional[int] = None, force: bool = False) -> None:
    chat_id = int(getattr(target, "chat_id", 0) or 0)
    now = time.time()
    if chat_id and not force:
        last = LAST_MENU_TS.get(chat_id, 0.0)
        if now - last < 90:
            return

    connected = False
    has_week_set = False
    if user_id:
        try:
            status = await _api_get(f"/strava/status/{user_id}")
            connected = bool(status.get("connected"))
        except Exception:
            connected = False
        try:
            await _api_get(f"/users/{user_id}/availability")
            has_week_set = True
        except Exception:
            has_week_set = False
    await target.reply_text(
        "You are set up. Use the buttons below.",
        reply_markup=_home_menu_keyboard(connected, has_week_set),
    )
    if chat_id:
        LAST_MENU_TS[chat_id] = now


async def _send_strava_connect_message(target, user_id: int) -> None:
    try:
        auth = await _api_get(f"/strava/auth?user_id={user_id}")
        url = auth["url"]
    except Exception:
        await target.reply_text(
            "I could not generate the Strava link yet. Please try again in a moment."
        )
        return

    await target.reply_text(
        "Connect Strava to import runs.\nIf callback fails on phone, paste the final URL with code= and state= here.",
        reply_markup=InlineKeyboardMarkup(
            [
                [InlineKeyboardButton(text="Connect Strava", url=url)],
                [InlineKeyboardButton(text="I've Connected", callback_data="menu:check_strava")],
            ]
        ),
    )


async def _send_strava_status_message(target, user_id: int) -> None:
    try:
        status = await _api_get(f"/strava/status/{user_id}")
    except Exception:
        await target.reply_text("I could not check Strava status right now.")
        return
    if status.get("connected"):
        name = status.get("athlete_name") or "Connected athlete"
        await target.reply_text(f"Strava is connected: {name}.")
    else:
        await target.reply_text("Strava is not connected yet. Use the main Connect Strava button.")


def _extract_code_state(text: str) -> tuple[Optional[str], Optional[str]]:
    if "code=" not in text or "state=" not in text:
        return None, None
    try:
        parsed = urlparse(text.strip())
        q = parse_qs(parsed.query)
        code = (q.get("code") or [None])[0]
        state = (q.get("state") or [None])[0]
        return code, state
    except Exception:
        return None, None


async def _generate_plan(user_id: int, weeks: int = 16) -> None:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(f"{API_BASE_URL}/plans/generate/{user_id}", params={"weeks": weeks})
        r.raise_for_status()


def _format_plan_day(day_data: dict, day_label: str) -> str:
    base = (
        f"{day_label}: {day_data.get('session_type', 'Run')} "
        f"({day_data.get('planned_km', 0)} km)"
    )
    note = day_data.get("notes")
    if note:
        return f"{base}\nNotes: {note}"
    return base


def _parse_c25k_notes(note: str) -> Optional[dict]:
    if not note or not str(note).startswith("C25K|"):
        return None
    out: dict = {}
    parts = str(note).split("|")[1:]
    for p in parts:
        if "=" not in p:
            continue
        k, v = p.split("=", 1)
        if k == "repeats":
            out[k] = int(float(v))
        else:
            out[k] = float(v)
    required = {"warmup", "run", "walk", "repeats", "cooldown"}
    if not required.issubset(set(out.keys())):
        return None
    return out


async def _interval_phase(chat_id: int, label: str, minutes: float, context: ContextTypes.DEFAULT_TYPE) -> None:
    if minutes <= 0:
        return
    await context.bot.send_message(chat_id=chat_id, text=f"🔊 {label} for {minutes:g} min")
    await asyncio.sleep(int(minutes * 60))


async def _run_c25k_session(
    user_id: int,
    chat_id: int,
    parsed: dict,
    context: ContextTypes.DEFAULT_TYPE,
) -> None:
    try:
        await context.bot.send_message(chat_id=chat_id, text="Starting guided session now.")
        warmup = float(parsed["warmup"])
        run_min = float(parsed["run"])
        walk_min = float(parsed["walk"])
        repeats = int(parsed["repeats"])
        cooldown = float(parsed["cooldown"])
        total_min = warmup + cooldown + (repeats * run_min) + (max(0, repeats - 1) * walk_min)
        half_mark_sec = int((total_min * 60) / 2)
        start_ts = asyncio.get_running_loop().time()

        await _interval_phase(chat_id, "Warm-up walk", warmup, context)
        repeats = int(parsed["repeats"])
        for idx in range(repeats):
            await _interval_phase(chat_id, f"Run ({idx + 1}/{repeats})", run_min, context)
            elapsed = int(asyncio.get_running_loop().time() - start_ts)
            if elapsed >= half_mark_sec and not context.user_data.get("turnaround_sent"):
                context.user_data["turnaround_sent"] = True
                await context.bot.send_message(chat_id=chat_id, text="🔊 Halfway point reached. Turn around now.")
            # Keep cooldown as the final walk.
            if idx < repeats - 1 and walk_min > 0:
                await _interval_phase(chat_id, f"Walk ({idx + 1}/{repeats - 1})", walk_min, context)
        await _interval_phase(chat_id, "Cool-down walk", cooldown, context)
        context.user_data.pop("turnaround_sent", None)
        created = await _create_manual_run_from_session(user_id, total_min)
        run_id = int(created.get("id")) if created and created.get("id") else None
        if run_id:
            await context.bot.send_message(
                chat_id=chat_id,
                text="Done. Nice work.\nQuick check-in: how hard was that run?",
                reply_markup=_feedback_keyboard(run_id, "effort"),
            )
        else:
            await context.bot.send_message(chat_id=chat_id, text="Done. Nice work.")
        await context.bot.send_message(
            chat_id=chat_id,
            text="Tip: you can add pilot feedback any time with /feedback",
        )
    finally:
        ACTIVE_SESSIONS.pop(user_id, None)


async def _start_today_session(target, user_id: int, context: ContextTypes.DEFAULT_TYPE) -> None:
    today = date.today()
    day_data = None
    try:
        day_data = await _api_get(f"/plans/day/{user_id}?day={today.isoformat()}")
    except Exception:
        try:
            await _generate_plan(user_id, weeks=16)
            day_data = await _api_get(f"/plans/day/{user_id}?day={today.isoformat()}")
        except Exception:
            day_data = None

    if day_data is None:
        # New users can still start a safe guided starter session immediately.
        parsed = {"warmup": 5.0, "run": 1.0, "walk": 1.5, "repeats": 8, "cooldown": 5.0}
        existing = ACTIVE_SESSIONS.get(user_id)
        if existing and not existing.done():
            await target.reply_text("You already have an active guided session. Say 'stop session' to stop it.")
            return
        task = asyncio.create_task(_run_c25k_session(user_id, target.chat_id, parsed, context))
        ACTIVE_SESSIONS[user_id] = task
        await target.reply_text(
            "No plan was ready for today yet, so I started a safe starter session "
            "(run 1 min / walk 1.5 min x 8)."
        )
        return

    parsed = _parse_c25k_notes(str(day_data.get("notes") or ""))
    if not parsed:
        session = str(day_data.get("session_type") or "").lower()
        planned_km = int(day_data.get("planned_km") or 0)
        if session != "rest" and planned_km > 0:
            steady_min = max(10, min(90, int(round(planned_km * 7.0))))
            parsed = {"warmup": 5.0, "run": float(steady_min), "walk": 0.0, "repeats": 1, "cooldown": 5.0}
        else:
            parsed = {"warmup": 5.0, "run": 1.0, "walk": 1.5, "repeats": 8, "cooldown": 5.0}
            await target.reply_text(
                "Today is currently a rest day in your plan. Starting an optional light starter session."
            )
    existing = ACTIVE_SESSIONS.get(user_id)
    if existing and not existing.done():
        await target.reply_text("You already have an active guided session. Say 'stop session' to stop it.")
        return
    task = asyncio.create_task(_run_c25k_session(user_id, target.chat_id, parsed, context))
    ACTIVE_SESSIONS[user_id] = task
    await target.reply_text("Guided session started. I will send each interval step.")


def _weeks_until(target: date) -> int:
    days = (target - date.today()).days
    return max(4, min(52, int(round(days / 7.0))))


def _date_from_option(value: str) -> Optional[date]:
    mapping = {
        "In 4 weeks": 4,
        "In 8 weeks": 8,
        "In 12 weeks": 12,
        "In 16 weeks": 16,
    }
    weeks = mapping.get(value)
    if weeks is None:
        return None
    return date.today() + timedelta(days=weeks * 7)


def _start_date_from_option(value: str) -> Optional[date]:
    today = date.today()
    if value == "Today":
        return today
    if value == "Tomorrow":
        return today + timedelta(days=1)
    if value == "Next Monday":
        return today + timedelta(days=(7 - today.weekday()))
    return None


def _format_latest_run(latest: dict) -> str:
    start = _format_user_datetime(str(latest.get("start_time", "")))
    dist_km = round((latest.get("distance_m", 0) or 0) / 1000.0, 2)
    dur_min = round((latest.get("duration_s", 0) or 0) / 60.0, 1)
    pace = ""
    if dist_km > 0:
        pace = f"{round(dur_min / dist_km, 2)} min/km"
    return f"Latest run: {start} | {dist_km} km | {dur_min} min | {pace}"


def _format_user_datetime(raw: str) -> str:
    if not raw:
        return "Unknown time"
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        local_dt = dt.astimezone(ZoneInfo("Australia/Sydney"))
        return local_dt.strftime("%a %d %b %Y, %-I:%M %p %Z").replace(" 0", " ")
    except Exception:
        return raw


async def _sync_and_report(target, user_id: int) -> None:
    sync = None
    try:
        sync = await _api_post(f"/strava/sync/{user_id}", {})
    except httpx.HTTPStatusError as exc:
        detail = ""
        try:
            body = exc.response.json()
            detail = str(body.get("detail") or "")
        except Exception:
            detail = exc.response.text[:120] if exc.response is not None else ""
        if detail:
            await target.reply_text(f"I could not sync Strava runs right now: {detail}")
        else:
            await target.reply_text("I could not sync Strava runs right now.")
        return
    except httpx.TimeoutException:
        # One retry for transient network hiccups.
        try:
            sync = await _api_post(f"/strava/sync/{user_id}", {})
        except Exception:
            await target.reply_text("I could not sync Strava runs right now (timeout). Please tap again.")
            return
    except Exception:
        await target.reply_text("I could not sync Strava runs right now.")
        return

    try:
        added = sync.get("added", 0)
        total = sync.get("total", 0)
        await target.reply_text(f"Sync complete: {added} new run(s) imported from {total} activities checked.")
    except Exception:
        await target.reply_text("Sync complete.")
        return

    try:
        latest = await _api_get(f"/runs/latest/{user_id}")
        if int(added or 0) > 0:
            await target.reply_text(_format_latest_run(latest))
        else:
            await target.reply_text(
                f"No new runs found. Most recent on record: {_format_latest_run(latest).replace('Latest run: ', '')}"
            )
    except Exception:
        await target.reply_text("No run history found yet.")
        await _send_home_menu_message(target, user_id, force=True)
        return

    await target.reply_text(
        "Great, sync is done. Next: tap Set This Week (or Adjust This Week) to tailor your plan."
    )
    await _send_home_menu_message(target, user_id, force=True)


async def _prompt_feedback_for_latest_run(target, user_id: int) -> None:
    try:
        latest = await _api_get(f"/runs/feedback/pending/{user_id}")
    except Exception:
        return
    run_id = int(latest.get("id"))
    await target.reply_text(
        "Quick check-in to personalize your plan:",
        reply_markup=_feedback_start_keyboard(run_id),
    )


def _is_same_day_in_au(raw_iso: str) -> bool:
    try:
        dt = datetime.fromisoformat(str(raw_iso).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        au = ZoneInfo("Australia/Sydney")
        return dt.astimezone(au).date() == datetime.now(au).date()
    except Exception:
        return False


async def _llm_intent_router(text: str) -> Optional[dict]:
    if not OPENAI_API_KEY:
        return None
    system = (
        "You classify running-coach user messages into intents only. "
        "Never answer content, never provide advice, never ask for or infer personal data. "
        "If message is not about run coaching/scheduling/strava/session control, return intent=unknown. "
        "Return strict JSON only with keys: intent, confidence, date_iso, reply_text. "
        "intent one of: plan_today, plan_tomorrow, plan_next_week, plan_date, "
        "set_week, connect_strava, strava_status, start_session, stop_session, "
        "next_steps, trends, unknown. "
        "confidence is 0-1. date_iso is YYYY-MM-DD or null. "
        "Use Australia/Sydney interpretation for relative dates."
    )
    scrubbed = re.sub(r"https?://\\S+", "[url]", text)
    scrubbed = re.sub(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}", "[email]", scrubbed)
    scrubbed = re.sub(r"\\b\\d{6,}\\b", "[number]", scrubbed)
    body = {
        "model": OPENAI_MODEL,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": scrubbed[:500]},
        ],
        "temperature": 0,
    }
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.post("https://api.openai.com/v1/chat/completions", json=body, headers=headers)
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"]
            data = json.loads(content)
            return data if isinstance(data, dict) else None
    except Exception:
        return None


async def _send_behavior_summary(
    target,
    user_id: int,
    apply_suggestions: bool = False,
    persist: bool = True,
) -> int:
    query = (
        f"?window_weeks=6"
        f"&apply_suggestions={'true' if apply_suggestions else 'false'}"
        f"&persist={'true' if persist else 'false'}"
    )
    try:
        data = await _api_post(f"/plans/behavior/{user_id}{query}", {})
    except Exception:
        await target.reply_text("I could not analyze behavior trends right now.")
        return 0

    rel = int(round((data.get("reliability_score", 0) or 0) * 100))
    adh = int(round((data.get("adherence_ratio", 0) or 0) * 100))
    lines = [
        f"Trend check ({data.get('period_start')} to {data.get('period_end')}):",
        f"- Reliability: {rel}%",
        f"- Adherence: {adh}%",
        f"- Delayed sessions: {data.get('delayed_sessions', 0)}",
    ]

    suggestions = data.get("suggestions", [])[:2]
    if suggestions:
        lines.append("Top suggestions:")
        for s in suggestions:
            lines.append(f"- {s.get('title')}: {s.get('action')}")
    else:
        lines.append("No major pattern issue detected yet.")

    for action in data.get("applied_actions", []):
        lines.append(f"Applied: {action}")

    await target.reply_text("\n".join(lines))
    return len(data.get("suggestions", []))


async def _finalize_week_availability(query, context, user_id: int, off_limits: set[str]) -> None:
    today = date.today()
    week_start = _week_start(today)
    off = {d.lower()[:3] for d in off_limits}

    payload = {
        "week_start": week_start.isoformat(),
        "mon": "mon" not in off,
        "tue": "tue" not in off,
        "wed": "wed" not in off,
        "thu": "thu" not in off,
        "fri": "fri" not in off,
        "sat": "sat" not in off,
        "sun": "sun" not in off,
    }
    await _api_post(f"/users/{user_id}/availability", payload)
    try:
        await _generate_plan(user_id, weeks=16)
    except Exception:
        pass

    context.user_data.pop("off_limits", None)
    context.user_data.pop("pending_week", None)

    status = {"connected": False}
    try:
        status = await _api_get(f"/strava/status/{user_id}")
    except Exception:
        pass

    if status.get("connected"):
        next_line = "Done. Weekly schedule saved.\nNext: tap Start Today's Session or ask 'what run do I have tomorrow?'."
    else:
        next_line = "Done. Weekly schedule saved.\nNext: connect Strava."

    await query.edit_message_text(
        next_line,
        reply_markup=_home_menu_keyboard(bool(status.get("connected")), True),
    )
    chat_id = int(getattr(query.message, "chat_id", 0) or 0)
    if chat_id:
        LAST_MENU_TS[chat_id] = time.time()


def _parse_explicit_date(text: str) -> Optional[date]:
    cleaned = text.lower()
    cleaned = re.sub(r"(\d+)(st|nd|rd|th)", r"\1", cleaned)

    m1 = re.search(r"\b(\d{1,2})\s+([a-zA-Z]+)(?:\s+(\d{4}))?\b", cleaned)
    if m1:
        day = int(m1.group(1))
        month_name = m1.group(2).lower()
        year = int(m1.group(3)) if m1.group(3) else date.today().year
        month = MONTHS.get(month_name)
        if month:
            try:
                parsed = date(year, month, day)
                if not m1.group(3) and parsed < date.today():
                    parsed = date(year + 1, month, day)
                return parsed
            except ValueError:
                return None

    m2 = re.search(r"\b([a-zA-Z]+)\s+(\d{1,2})(?:\s+(\d{4}))?\b", cleaned)
    if m2:
        month_name = m2.group(1).lower()
        day = int(m2.group(2))
        year = int(m2.group(3)) if m2.group(3) else date.today().year
        month = MONTHS.get(month_name)
        if month:
            try:
                parsed = date(year, month, day)
                if not m2.group(3) and parsed < date.today():
                    parsed = date(year + 1, month, day)
                return parsed
            except ValueError:
                return None
    return None


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = await _ensure_user(update)
    try:
        onboarding = await _api_get(f"/users/{user['id']}/onboarding")
    except httpx.HTTPStatusError:
        onboarding = None

    if onboarding and onboarding.get("current_step") == 99:
        await _send_home_menu_message(update.message, user["id"], force=True)
        return
    if onboarding and onboarding.get("current_step", 1) > 1:
        step = int(onboarding.get("current_step", 1))
        while step <= TOTAL_ONBOARD_STEPS and _should_skip_step(step, onboarding):
            step += 1
            await _api_post(f"/users/{user['id']}/onboarding", {"current_step": step})
            onboarding = await _api_get(f"/users/{user['id']}/onboarding")
        if 1 <= step <= TOTAL_ONBOARD_STEPS:
            await update.message.reply_text(
                _onboarding_prompt(step, onboarding),
                reply_markup=_question_keyboard(step, onboarding),
            )
            return

    await _api_post(f"/users/{user['id']}/onboarding", {"current_step": 1})
    await update.message.reply_text(
        _onboarding_prompt(1, {}),
        reply_markup=_question_keyboard(1, {}),
    )


async def onboard_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    user = await _ensure_user(update)
    parts = (query.data or "").split(":", 2)
    if len(parts) != 3:
        await query.edit_message_text("Sorry, I didn’t understand that.")
        return

    _, step_s, value = parts
    step = int(step_s)
    onboarding = await _api_get(f"/users/{user['id']}/onboarding")
    _, _, field = _onboarding_question(step, onboarding)

    payload = {"current_step": step, field: value}
    if field == "goal_date":
        if value == "Pick date":
            context.user_data["awaiting_date_field"] = "goal_date"
            context.user_data["awaiting_date_step"] = step
            context.user_data["awaiting_date_user"] = user["id"]
            await query.edit_message_text(
                "Type your target date (e.g., 1 April 2026), or choose an option below.",
                reply_markup=_onboarding_date_keyboard("goal_date"),
            )
            return
        target = _date_from_option(value)
        if target:
            payload["goal_date"] = target.isoformat()
            payload["timeline_weeks"] = _weeks_until(target)
    if field == "start_date":
        if value == "Pick date":
            context.user_data["awaiting_date_field"] = "start_date"
            context.user_data["awaiting_date_step"] = step
            context.user_data["awaiting_date_user"] = user["id"]
            await query.edit_message_text(
                "Type your preferred start date (e.g., 7 March 2026).",
                reply_markup=_onboarding_date_keyboard("start_date"),
            )
            return
        start_d = _start_date_from_option(value)
        if start_d:
            payload["start_date"] = start_d.isoformat()
    if field == "weekly_availability":
        payload[field] = 5 if value == "5+" else int(value)
    if field == "continuous_run_min":
        mapping = {
            "0-5 min": 5,
            "5-10 min": 10,
            "10-20 min": 20,
            "20-30 min": 30,
            "30+ min": 35,
        }
        payload[field] = mapping.get(value, 10)
    if field == "recent_runs_per_week":
        mapping = {
            "0 days/week": 0,
            "1 day/week": 1,
            "2-3 days/week": 3,
            "4+ days/week": 4,
        }
        payload[field] = mapping.get(value, 0)
        if payload[field] == 0:
            payload["longest_recent_min"] = 0
    if field == "longest_recent_min":
        mapping = {
            "Under 15 min": 10,
            "15-30 min": 30,
            "30-45 min": 45,
            "45+ min": 60,
        }
        payload[field] = mapping.get(value, 15)

    await _api_post(f"/users/{user['id']}/onboarding", payload)

    if step < TOTAL_ONBOARD_STEPS:
        next_step = step + 1
        updated = await _api_get(f"/users/{user['id']}/onboarding")
        while next_step <= TOTAL_ONBOARD_STEPS and _should_skip_step(next_step, updated):
            await _api_post(f"/users/{user['id']}/onboarding", {"current_step": next_step})
            next_step += 1
            updated = await _api_get(f"/users/{user['id']}/onboarding")
        if next_step > TOTAL_ONBOARD_STEPS:
            await _complete_onboarding(query, user)
            return
        await query.edit_message_text(
            _onboarding_prompt(next_step, updated),
            reply_markup=_question_keyboard(next_step, updated),
        )
        return

    await _complete_onboarding(query, user)


async def _complete_onboarding(query, user: dict) -> None:
    onboarding = await _api_get(f"/users/{user['id']}/onboarding")
    profile_payload = {
        "goal_mode": onboarding.get("goal_mode"),
        "goal_primary": onboarding.get("goal_primary"),
        "goal_date": onboarding.get("goal_date"),
        "start_date": onboarding.get("start_date"),
        "timeline_weeks": onboarding.get("timeline_weeks"),
        "ability_level": onboarding.get("ability_level"),
        "weekly_availability": onboarding.get("weekly_availability"),
        "time_per_run": onboarding.get("time_per_run"),
        "recent_runs_per_week": onboarding.get("recent_runs_per_week"),
        "longest_recent_min": onboarding.get("longest_recent_min"),
        "continuous_run_min": onboarding.get("continuous_run_min"),
        "run_walk_ok": onboarding.get("run_walk_ok"),
        "injury_status": onboarding.get("injury_status"),
        "preferred_days": onboarding.get("preferred_days"),
    }
    await _api_post(f"/users/{user['id']}/profile", profile_payload)
    await _api_post(f"/users/{user['id']}/onboarding", {"current_step": 99})
    note = _feasibility_note(profile_payload)
    try:
        await _generate_plan(user["id"], weeks=16)
    except Exception:
        pass

    status = {"connected": False}
    try:
        status = await _api_get(f"/strava/status/{user['id']}")
    except Exception:
        pass
    lines = ["Setup complete."]
    if note:
        lines.append(note)
    if status.get("connected"):
        lines.append("Next: tap Start Today's Session or Adjust This Week.")
    else:
        lines.append("Next: connect Strava from the menu.")
    has_week_set = False
    try:
        await _api_get(f"/users/{user['id']}/availability")
        has_week_set = True
    except Exception:
        pass
    await query.edit_message_text(
        "\n".join(lines),
        reply_markup=_home_menu_keyboard(bool(status.get("connected")), has_week_set),
    )
    chat_id = int(getattr(query.message, "chat_id", 0) or 0)
    if chat_id:
        LAST_MENU_TS[chat_id] = time.time()


async def onboard_days_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user = await _ensure_user(update)
    parts = (query.data or "").split(":", 2)
    if len(parts) != 3:
        await query.edit_message_text("Sorry, I didn’t understand that.")
        return
    _, step_s, value = parts
    step = int(step_s)
    selected = set(context.user_data.get("onb_preferred_days", []))

    if value != "Done":
        if value == "All Days":
            value_out = "/".join(WEEK_DAYS)
            await _api_post(
                f"/users/{user['id']}/onboarding",
                {"current_step": step, "preferred_days": value_out},
            )
            context.user_data.pop("onb_preferred_days", None)
            await _complete_onboarding(query, user)
            return
        else:
            if value in selected:
                selected.remove(value)
            else:
                selected.add(value)
        context.user_data["onb_preferred_days"] = [d for d in WEEK_DAYS if d in selected]
        label = ", ".join([d for d in WEEK_DAYS if d in selected]) if selected else "none yet"
        await query.edit_message_text(
            f"Preferred days: {label}\nTap days, then Done.",
            reply_markup=_question_keyboard(step, {}),
        )
        return

    if not selected:
        await query.edit_message_text(
            "Please pick at least one preferred day.",
            reply_markup=_question_keyboard(step, {}),
        )
        return

    value_out = "/".join([d for d in WEEK_DAYS if d in selected])
    await _api_post(
        f"/users/{user['id']}/onboarding",
        {"current_step": step, "preferred_days": value_out},
    )
    context.user_data.pop("onb_preferred_days", None)
    await _complete_onboarding(query, user)


async def onboarding_date_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user = await _ensure_user(update)
    parts = (query.data or "").split(":")
    if len(parts) != 3:
        await query.edit_message_text("Sorry, I didn’t understand that date option.")
        return
    _, field, action = parts
    if action == "back":
        context.user_data.pop("awaiting_date_field", None)
        context.user_data.pop("awaiting_date_step", None)
        context.user_data.pop("awaiting_date_user", None)
        step = 3 if field == "goal_date" else 4
        onboarding = await _api_get(f"/users/{user['id']}/onboarding")
        await query.edit_message_text(
            _onboarding_prompt(step, onboarding),
            reply_markup=_question_keyboard(step, onboarding),
        )
        return
    if field == "goal_date" and action == "use12":
        await _api_post(
            f"/users/{user['id']}/onboarding",
            {"current_step": 3, "timeline_weeks": 12, "goal_date": None},
        )
        context.user_data.pop("awaiting_date_field", None)
        context.user_data.pop("awaiting_date_step", None)
        context.user_data.pop("awaiting_date_user", None)
        updated = await _api_get(f"/users/{user['id']}/onboarding")
        await query.edit_message_text(
            _onboarding_prompt(4, updated),
            reply_markup=_question_keyboard(4, updated),
        )
        return
    await query.edit_message_text("Sorry, I didn’t understand that date option.")


async def set_week(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data["off_limits"] = set()
    user = await _ensure_user(update)
    await _send_set_week_prompt(update.message, user["id"])


async def feedback_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = await _ensure_user(update)
    text = " ".join(context.args).strip() if context.args else ""
    if not text:
        context.user_data["awaiting_pilot_feedback"] = True
        await update.message.reply_text("Send your feedback now and I will log it for the pilot.")
        return
    try:
        await _api_post(
            f"/runs/pilot-feedback/{user['id']}",
            {"source": "chat", "category": "pilot", "text": text},
        )
        context.user_data.pop("awaiting_pilot_feedback", None)
        await update.message.reply_text("Thanks. Feedback saved.")
    except Exception:
        await update.message.reply_text("I could not save that feedback right now.")


async def bug_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = await _ensure_user(update)
    text = " ".join(context.args).strip() if context.args else ""
    if not text:
        context.user_data["awaiting_bug_feedback"] = True
        await update.message.reply_text("Send the bug note now and I will log it.")
        return
    try:
        await _api_post(
            f"/runs/pilot-feedback/{user['id']}",
            {"source": "chat", "category": "bug", "text": text},
        )
        context.user_data.pop("awaiting_bug_feedback", None)
        await update.message.reply_text("Bug logged. Thanks.")
    except Exception:
        await update.message.reply_text("I could not save that bug report right now.")


async def menu_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    user = await _ensure_user(update)
    choice = (query.data or "").split(":", 1)[1]

    if choice == "connect_strava":
        try:
            auth = await _api_get(f"/strava/auth?user_id={user['id']}")
            url = auth["url"]
            await query.edit_message_text(
                "Connect Strava to import runs.\nIf callback fails on phone, paste the final URL with code= and state= here.",
                reply_markup=InlineKeyboardMarkup(
                    [
                        [InlineKeyboardButton(text="Connect Strava", url=url)],
                        [InlineKeyboardButton(text="I've Connected", callback_data="menu:check_strava")],
                    ]
                ),
            )
        except Exception:
            await query.edit_message_text("I could not generate the Strava link yet. Please try again.")
        return
    if choice == "strava_status":
        await _send_strava_status_message(query.message, user["id"])
        return
    if choice == "check_strava":
        try:
            status = await _api_get(f"/strava/status/{user['id']}")
        except Exception:
            status = {"connected": False}
        if status.get("connected"):
            await query.message.reply_text("Strava connected. Syncing your runs now.")
            await _sync_and_report(query.message, user["id"])
        else:
            await query.message.reply_text(
                "Still waiting for Strava callback.\nIf phone callback failed, paste the final URL here."
            )
        return
    if choice == "start_session":
        await _start_today_session(query.message, user["id"], context)
        return
    if choice == "set_week":
        context.user_data["off_limits"] = set()
        await _send_set_week_prompt(query.message, user["id"])
        return
    await query.edit_message_text("Sorry, I did not understand that.")


async def week_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    choice = (query.data or "").split(":", 1)[1]
    off_limits = context.user_data.setdefault("off_limits", set())

    if choice != "Done":
        if choice in off_limits:
            off_limits.remove(choice)
        else:
            off_limits.add(choice)

        label = ", ".join(sorted(off_limits)) if off_limits else "none"
        await query.edit_message_text(
            f"Off-limits so far: {label}\nTap more days or Done.",
            reply_markup=query.message.reply_markup,
        )
        return

    user = await _ensure_user(update)
    available_days = 7 - len(off_limits)
    desired_days = 0
    try:
        week = await _api_get(
            f"/plans/week/{user['id']}?week_start={_week_start(date.today()).isoformat()}"
        )
        desired_days = sum(
            1
            for d in week.get("days", [])
            if str(d.get("session_type") or "").lower() != "rest"
            and (
                int(d.get("planned_km") or 0) > 0
                or str(d.get("notes") or "").startswith("C25K|")
            )
        )
    except Exception:
        desired_days = 0

    if desired_days and available_days < desired_days:
        context.user_data["pending_week"] = {
            "off_limits": sorted(list(off_limits)),
            "available_days": available_days,
            "desired_days": desired_days,
        }
        await query.edit_message_text(
            f"You marked {available_days} available day(s), but this week's plan currently needs {desired_days} run day(s).\n"
            "Do you want to keep a reduced-load week or re-pick days?",
            reply_markup=_week_capacity_keyboard(),
        )
        return

    await _finalize_week_availability(query, context, user["id"], off_limits)


async def week_capacity_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    choice = (query.data or "").split(":", 1)[1]
    pending = context.user_data.get("pending_week") or {}
    off_limits = set(pending.get("off_limits", []))

    if choice == "edit":
        context.user_data["off_limits"] = off_limits
        label = ", ".join(sorted(off_limits)) if off_limits else "none"
        await query.edit_message_text(
            f"Off-limits so far: {label}\nTap more days or Done.",
            reply_markup=_week_keyboard(),
        )
        return

    user = await _ensure_user(update)
    await _finalize_week_availability(query, context, user["id"], off_limits)


async def behavior_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user = await _ensure_user(update)
    choice = (query.data or "").split(":", 1)[1]
    if choice == "apply":
        await query.edit_message_text("Applying trend-based suggestions now.")
        await _send_behavior_summary(query.message, user["id"], apply_suggestions=True, persist=True)
        return
    await query.edit_message_text("Okay, skipped suggestions for now.")


async def feedback_start_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    parts = (query.data or "").split(":", 1)
    if len(parts) != 2:
        await query.edit_message_text("Could not start check-in.")
        return
    run_id = int(parts[1])
    context.user_data["feedback_run_id"] = run_id
    context.user_data["feedback_data"] = {}
    await query.edit_message_text(
        "How hard was that run? (1 very easy, 10 max)",
        reply_markup=_feedback_keyboard(run_id, "effort"),
    )


async def feedback_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user = await _ensure_user(update)
    parts = (query.data or "").split(":", 3)
    if len(parts) != 4:
        await query.edit_message_text("Could not save check-in.")
        return
    _, run_id_s, stage, value = parts
    run_id = int(run_id_s)
    data = context.user_data.setdefault("feedback_data", {})
    stage_map = {
        "effort": "effort",
        "fatigue": "fatigue",
        "pain": "pain",
        "feel": "session_feel",
    }
    if stage not in stage_map:
        await query.edit_message_text("Unknown check-in stage.")
        return
    data[stage_map[stage]] = value

    if stage == "effort":
        await query.edit_message_text(
            "Leg fatigue right now? (1 fresh, 10 very heavy)",
            reply_markup=_feedback_keyboard(run_id, "fatigue"),
        )
        return
    if stage == "fatigue":
        await query.edit_message_text(
            "Any niggling pain? (1 none, 10 severe)",
            reply_markup=_feedback_keyboard(run_id, "pain"),
        )
        return
    if stage == "pain":
        await query.edit_message_text(
            "How did the session feel vs plan?",
            reply_markup=_feedback_keyboard(run_id, "feel"),
        )
        return

    payload = {
        "run_id": run_id,
        "effort": data.get("effort", "5"),
        "fatigue": data.get("fatigue", "3"),
        "pain": data.get("pain", "1"),
        "session_feel": data.get("session_feel", "about_right"),
    }
    try:
        effort_score = int(str(payload["effort"]))
        fatigue_score = int(str(payload["fatigue"]))
        pain_score = int(str(payload["pain"]))
    except Exception:
        effort_score = 5
        fatigue_score = 3
        pain_score = 1

    payload["effort"] = "max" if effort_score >= 9 else ("hard" if effort_score >= 7 else ("moderate" if effort_score >= 4 else "easy"))
    payload["fatigue"] = "very_heavy" if fatigue_score >= 8 else ("heavy" if fatigue_score >= 5 else "fresh")
    payload["pain"] = "pain_form" if pain_score >= 7 else ("minor" if pain_score >= 4 else "none")
    payload["notes"] = f"scores effort={effort_score}, fatigue={fatigue_score}, pain={pain_score}"
    actions = []
    try:
        saved = await _api_post(f"/runs/feedback/{user['id']}", payload)
        actions = saved.get("actions_applied", []) or []
    except Exception:
        await query.edit_message_text("Saved failed. Please try again.")
        return

    try:
        ach = await _api_post(f"/runs/achievements/check/{user['id']}?run_id={run_id}", {})
        created = ach.get("created", []) or []
    except Exception:
        created = []

    lines = ["Check-in saved. Thanks."]
    for action in actions:
        lines.append(f"Coach update: {action}")
    for item in created:
        lines.append(f"Achievement: {item.get('title')} — {item.get('detail')}")
    if len(lines) == 1:
        lines.append("No plan changes needed right now.")
    await query.edit_message_text("\n".join(lines))
    context.user_data.pop("feedback_data", None)


async def text_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.message or not update.message.text:
        return
    msg = update.message.text.strip()
    lower = msg.lower()
    user = await _ensure_user(update)

    if context.user_data.get("awaiting_pilot_feedback"):
        try:
            await _api_post(
                f"/runs/pilot-feedback/{user['id']}",
                {"source": "chat", "category": "pilot", "text": msg},
            )
            context.user_data.pop("awaiting_pilot_feedback", None)
            await update.message.reply_text("Thanks. Feedback saved.")
        except Exception:
            await update.message.reply_text("I could not save that feedback right now.")
        return
    if context.user_data.get("awaiting_bug_feedback"):
        try:
            await _api_post(
                f"/runs/pilot-feedback/{user['id']}",
                {"source": "chat", "category": "bug", "text": msg},
            )
            context.user_data.pop("awaiting_bug_feedback", None)
            await update.message.reply_text("Bug logged. Thanks.")
        except Exception:
            await update.message.reply_text("I could not save that bug report right now.")
        return

    if (
        context.user_data.get("awaiting_date_field")
        and context.user_data.get("awaiting_date_user") == user["id"]
    ):
        field = str(context.user_data.get("awaiting_date_field"))
        step = int(context.user_data.get("awaiting_date_step") or (3 if field == "goal_date" else 4))
        parsed = _parse_explicit_date(msg) or _parse_explicit_date(lower)
        if not parsed:
            await update.message.reply_text(
                "I could not read that date. Try: 1 April 2026, or choose below.",
                reply_markup=_onboarding_date_keyboard(field),
            )
            return
        if field == "goal_date" and parsed <= date.today():
            await update.message.reply_text("Please choose a future date.")
            return
        if field == "start_date" and parsed < date.today():
            await update.message.reply_text("Please choose today or a future date.")
            return
        payload = {"current_step": step, field: parsed.isoformat()}
        if field == "goal_date":
            payload["timeline_weeks"] = _weeks_until(parsed)
        await _api_post(
            f"/users/{user['id']}/onboarding",
            payload,
        )
        context.user_data.pop("awaiting_date_field", None)
        context.user_data.pop("awaiting_date_step", None)
        context.user_data.pop("awaiting_date_user", None)
        next_step = step + 1
        updated = await _api_get(f"/users/{user['id']}/onboarding")
        await update.message.reply_text(
            _onboarding_prompt(next_step, updated),
            reply_markup=_question_keyboard(next_step, updated),
        )
        return

    mode = await _get_engagement_mode(user["id"])
    chat_type = (update.effective_chat.type if update.effective_chat else "private")
    addressed = _is_addressed(update, context.bot.username or "")

    requested_mode = _parse_mode(lower)
    if requested_mode:
        await _api_post(f"/users/{user['id']}/onboarding", {"engagement_mode": requested_mode})
        await update.message.reply_text(
            f"Engagement mode set to {requested_mode}. "
            "Options: always_on, wake_word, command_only."
        )
        return

    if chat_type in {"group", "supergroup"} and not addressed:
        return
    if mode == "wake_word" and not addressed:
        return
    if mode == "command_only" and chat_type == "private" and not lower.startswith("coach"):
        return

    msg = _strip_wake_word(msg)
    lower = msg.lower()

    intent = await _llm_intent_router(msg)
    if intent and float(intent.get("confidence", 0) or 0) >= 0.7:
        i = str(intent.get("intent") or "unknown")
        if i == "connect_strava":
            try:
                status = await _api_get(f"/strava/status/{user['id']}")
            except Exception:
                status = {"connected": False}
            if status.get("connected"):
                await update.message.reply_text("Strava is already connected. Syncing now.")
                await _sync_and_report(update.message, user["id"])
            else:
                await _send_strava_connect_message(update.message, user["id"])
            return
        if i == "strava_status":
            await _send_strava_status_message(update.message, user["id"])
            return
        if i == "set_week":
            await set_week(update, context)
            return
        if i == "start_session":
            await _start_today_session(update.message, user["id"], context)
            return
        if i == "stop_session":
            task = ACTIVE_SESSIONS.get(user["id"])
            if task and not task.done():
                task.cancel()
                ACTIVE_SESSIONS.pop(user["id"], None)
                await update.message.reply_text("Guided session stopped.")
            else:
                await update.message.reply_text("No active guided session to stop.")
            return
        if i == "next_steps":
            connected = False
            has_week_set = False
            try:
                st = await _api_get(f"/strava/status/{user['id']}")
                connected = bool(st.get("connected"))
            except Exception:
                pass
            try:
                await _api_get(f"/users/{user['id']}/availability")
                has_week_set = True
            except Exception:
                pass
            if not connected:
                text = "Next step: connect Strava so I can import your runs."
            elif not has_week_set:
                text = "Next step: set this week so I can tailor your schedule."
            else:
                text = "Next step: start today's session, or ask 'what run do I have tomorrow?'."
            await update.message.reply_text(text, reply_markup=_home_menu_keyboard(connected, has_week_set))
            return
        if i in {"plan_today", "plan_tomorrow", "plan_date"}:
            target = date.today()
            if i == "plan_tomorrow":
                target = date.today() + timedelta(days=1)
            if i == "plan_date" and intent.get("date_iso"):
                try:
                    target = date.fromisoformat(str(intent.get("date_iso")))
                except Exception:
                    target = date.today()
            try:
                day_data = await _api_get(f"/plans/day/{user['id']}?day={target.isoformat()}")
                lbl = "Today" if target == date.today() else target.strftime("%a %d %b %Y")
                await update.message.reply_text(_format_plan_day(day_data, lbl))
            except Exception:
                await update.message.reply_text(f"No planned run found for {target.strftime('%d %b %Y')}.")
            return
        if i == "plan_next_week":
            wk = _week_start(date.today()) + timedelta(days=7)
            try:
                week = await _api_get(f"/plans/week/{user['id']}?week_start={wk.isoformat()}")
                lines = [f"Next week ({wk.isoformat()}) - {week.get('focus', 'Planned')}"]
                for d in week.get("days", []):
                    lines.append(f"{d.get('day')}: {d.get('session_type')} ({d.get('planned_km')} km)")
                await update.message.reply_text("\n".join(lines))
            except Exception:
                await update.message.reply_text("I could not find next week's plan yet.")
            return
        if i == "trends":
            await _send_behavior_summary(update.message, user["id"], apply_suggestions=False)
            return

    code, state = _extract_code_state(msg)
    if code and state:
        try:
            await _api_post(
                f"/strava/exchange/{user['id']}",
                {"code": code, "state": state},
            )
            await update.message.reply_text("Strava connected. Syncing your runs now.")
            await _sync_and_report(update.message, user["id"])
        except Exception:
            await update.message.reply_text(
                "I could not complete the Strava link from that URL. Please try connect again."
            )
        return

    if "connect strava" in lower or "link strava" in lower:
        try:
            status = await _api_get(f"/strava/status/{user['id']}")
        except Exception:
            status = {"connected": False}
        if status.get("connected"):
            await update.message.reply_text("Strava is already connected. Syncing now.")
            await _sync_and_report(update.message, user["id"])
        else:
            await _send_strava_connect_message(update.message, user["id"])
        return
    if "wrong strava" in lower or "disconnect strava" in lower:
        try:
            await _api_post(f"/strava/disconnect/{user['id']}?wipe_runs=true", {})
            await update.message.reply_text(
                "Disconnected Strava and cleared imported runs for this user. Tap Connect Strava to relink."
            )
        except Exception:
            await update.message.reply_text("I could not disconnect Strava right now.")
        return
    if "strava status" in lower or "am i connected" in lower or lower == "status":
        await _send_strava_status_message(update.message, user["id"])
        return

    if "set week" in lower or "off limits" in lower:
        await set_week(update, context)
        return

    if "start session" in lower or "begin session" in lower:
        await _start_today_session(update.message, user["id"], context)
        return

    if "stop session" in lower:
        task = ACTIVE_SESSIONS.get(user["id"])
        if task and not task.done():
            task.cancel()
            ACTIVE_SESSIONS.pop(user["id"], None)
            await update.message.reply_text("Guided session stopped.")
        else:
            await update.message.reply_text("No active guided session to stop.")
        return

    if "strava.com/oauth/accept_application" in lower and "code=" not in lower:
        await update.message.reply_text(
            "That link is the pre-approval URL. After approving, copy the final URL that contains both code= and state= and paste it here."
        )
        return

    if "tomorrow" in lower:
        target = date.today() + timedelta(days=1)
        try:
            day_data = await _api_get(f"/plans/day/{user['id']}?day={target.isoformat()}")
            await update.message.reply_text(_format_plan_day(day_data, "Tomorrow"))
        except Exception:
            await update.message.reply_text("I do not have tomorrow's plan yet. Generating it now.")
            try:
                await _generate_plan(user["id"], weeks=16)
                day_data = await _api_get(f"/plans/day/{user['id']}?day={target.isoformat()}")
                await update.message.reply_text(_format_plan_day(day_data, "Tomorrow"))
            except Exception:
                await update.message.reply_text("Still no planned run for tomorrow.")
        return

    if "today" in lower or "how far am i running" in lower or "what run do i have" in lower:
        target = date.today()
        try:
            day_data = await _api_get(f"/plans/day/{user['id']}?day={target.isoformat()}")
            await update.message.reply_text(_format_plan_day(day_data, "Today"))
        except Exception:
            await update.message.reply_text("I do not have today's plan yet. Generating it now.")
            try:
                await _generate_plan(user["id"], weeks=16)
                day_data = await _api_get(f"/plans/day/{user['id']}?day={target.isoformat()}")
                await update.message.reply_text(_format_plan_day(day_data, "Today"))
            except Exception:
                await update.message.reply_text("No planned run found for today.")
        return

    if "next week" in lower:
        wk = _week_start(date.today()) + timedelta(days=7)
        try:
            week = await _api_get(f"/plans/week/{user['id']}?week_start={wk.isoformat()}")
            lines = [f"Next week ({wk.isoformat()}) - {week.get('focus', 'Planned')}"]
            for d in week.get("days", []):
                lines.append(f"{d.get('day')}: {d.get('session_type')} ({d.get('planned_km')} km)")
            await update.message.reply_text("\n".join(lines))
        except Exception:
            await update.message.reply_text("I could not find next week's plan yet.")
        return

    if "next step" in lower or "next steps" in lower or "what should i do next" in lower:
        connected = False
        has_week_set = False
        try:
            st = await _api_get(f"/strava/status/{user['id']}")
            connected = bool(st.get("connected"))
        except Exception:
            connected = False
        try:
            await _api_get(f"/users/{user['id']}/availability")
            has_week_set = True
        except Exception:
            has_week_set = False

        if not connected:
            text = "Next step: connect Strava so I can import your runs."
        elif not has_week_set:
            text = "Next step: set this week so I can tailor your schedule."
        else:
            text = "Next step: start today's session, or ask 'what run do I have tomorrow?'."
        await update.message.reply_text(
            text,
            reply_markup=_home_menu_keyboard(connected, has_week_set),
        )
        chat_id = int(getattr(update.message, "chat_id", 0) or 0)
        if chat_id:
            LAST_MENU_TS[chat_id] = time.time()
        return

    if "coach trends" in lower or "my trends" in lower or "patterns" in lower:
        await _send_behavior_summary(update.message, user["id"], apply_suggestions=False)
        return

    explicit = _parse_explicit_date(lower)
    if explicit:
        try:
            day_data = await _api_get(f"/plans/day/{user['id']}?day={explicit.isoformat()}")
            await update.message.reply_text(_format_plan_day(day_data, explicit.strftime("%a %d %b %Y")))
        except Exception:
            await update.message.reply_text(
                f"No planned run found for {explicit.strftime('%d %b %Y')}."
            )
        return

    await update.message.reply_text(
        "I didn't catch that. Try: today, tomorrow, next week, set week, connect strava, /feedback, or 'what are my next steps?'."
    )


def main() -> None:
    app = ApplicationBuilder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("onboard", start))
    app.add_handler(CommandHandler("setweek", set_week))
    app.add_handler(CommandHandler("feedback", feedback_command))
    app.add_handler(CommandHandler("bug", bug_command))
    app.add_handler(CallbackQueryHandler(menu_callback, pattern=r"^menu:"))
    app.add_handler(CallbackQueryHandler(onboarding_date_callback, pattern=r"^onbdate:"))
    app.add_handler(CallbackQueryHandler(onboard_days_callback, pattern=r"^onbday:"))
    app.add_handler(CallbackQueryHandler(onboard_callback, pattern=r"^onb:"))
    app.add_handler(CallbackQueryHandler(week_callback, pattern=r"^wk:"))
    app.add_handler(CallbackQueryHandler(week_capacity_callback, pattern=r"^wkc:"))
    app.add_handler(CallbackQueryHandler(behavior_callback, pattern=r"^beh:"))
    app.add_handler(CallbackQueryHandler(feedback_start_callback, pattern=r"^fbstart:"))
    app.add_handler(CallbackQueryHandler(feedback_callback, pattern=r"^fb:"))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, text_message))

    app.run_polling()


if __name__ == "__main__":
    main()
