#!/usr/bin/env python3
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List

from dotenv import load_dotenv
from google.oauth2 import service_account
from googleapiclient.discovery import build
from sqlalchemy import create_engine, text

PROJECT_DIR = Path("/Users/michaelbuttsworth/.openclaw/motioncoachlab")
DEFAULT_ENV = Path("/Users/michaelbuttsworth/.openclaw/.env")
DEFAULT_CREDS = Path("/Users/michaelbuttsworth/.openclaw/secrets/google_sheets.json")
DEFAULT_SHEET_ID = "1zomqLaWOuV92pKD0U28EJLjDaxIuzgz8z8Q_f3uwiSg"

SHEETS_SCOPE = ["https://www.googleapis.com/auth/spreadsheets"]


def log(msg: str) -> None:
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")


def load_settings() -> Dict[str, str]:
    env_file = Path(os.getenv("ENV_FILE", str(DEFAULT_ENV)))
    if env_file.exists():
        load_dotenv(env_file)

    database_url = os.getenv("DATABASE_URL", "sqlite:///./dev.db")
    if database_url == "sqlite:///./dev.db":
        database_url = f"sqlite:///{PROJECT_DIR / 'dev.db'}"

    return {
        "database_url": database_url,
        "creds_file": os.getenv("GOOGLE_SHEETS_CREDENTIALS", str(DEFAULT_CREDS)),
        "sheet_id": os.getenv("MOTIONCOACH_SHEET_ID", DEFAULT_SHEET_ID),
    }


def get_sheets_service(creds_file: str):
    creds = service_account.Credentials.from_service_account_file(creds_file, scopes=SHEETS_SCOPE)
    return build("sheets", "v4", credentials=creds)


def ensure_tabs(service, spreadsheet_id: str, tabs: List[str]) -> None:
    meta = service.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()
    existing = {s.get("properties", {}).get("title", "") for s in meta.get("sheets", [])}
    requests = []
    for tab in tabs:
        if tab not in existing:
            requests.append({"addSheet": {"properties": {"title": tab}}})
    if requests:
        service.spreadsheets().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={"requests": requests},
        ).execute()


def write_tab(service, spreadsheet_id: str, tab: str, values: List[List[str]]) -> None:
    if not values:
        values = [["No data"]]
    service.spreadsheets().values().clear(
        spreadsheetId=spreadsheet_id,
        range=f"{tab}!A:Z",
    ).execute()
    service.spreadsheets().values().update(
        spreadsheetId=spreadsheet_id,
        range=f"{tab}!A1",
        valueInputOption="RAW",
        body={"values": values},
    ).execute()


def fetch_rows(database_url: str) -> Dict[str, List[dict]]:
    engine = create_engine(database_url)
    with engine.connect() as conn:
        users = conn.execute(
            text(
                """
                SELECT u.id, u.name, u.email, u.telegram_id, u.created_at,
                       CASE WHEN st.id IS NULL THEN 'No' ELSE 'Yes' END AS strava_connected
                FROM users u
                LEFT JOIN strava_tokens st ON st.user_id = u.id
                ORDER BY u.id
                """
            )
        ).mappings().all()

        profiles = conn.execute(
            text(
                """
                SELECT p.user_id, u.name, p.goal_mode, p.goal_primary, p.goal_date, p.start_date, p.timeline_weeks, p.ability_level,
                       p.weekly_availability, p.time_per_run, p.recent_runs_per_week,
                       p.longest_recent_min, p.continuous_run_min, p.run_walk_ok,
                       p.injury_status, p.preferred_days
                FROM profiles p
                JOIN users u ON u.id = p.user_id
                ORDER BY p.user_id
                """
            )
        ).mappings().all()

        runs = conn.execute(
            text(
                """
                SELECT r.user_id, u.name, r.source, r.source_id, r.start_time,
                       r.distance_m, r.duration_s
                FROM runs r
                JOIN users u ON u.id = r.user_id
                ORDER BY r.start_time DESC
                """
            )
        ).mappings().all()

        availability = conn.execute(
            text(
                """
                SELECT a.user_id, u.name, a.week_start, a.mon, a.tue, a.wed, a.thu, a.fri, a.sat, a.sun
                FROM weekly_availability a
                JOIN users u ON u.id = a.user_id
                ORDER BY a.week_start DESC
                """
            )
        ).mappings().all()

        plan_weeks = conn.execute(
            text(
                """
                SELECT w.user_id, u.name, w.week_start, w.focus, w.target_km
                FROM plan_weeks w
                JOIN users u ON u.id = w.user_id
                ORDER BY w.week_start ASC
                """
            )
        ).mappings().all()

        plan_days = conn.execute(
            text(
                """
                SELECT p.user_id, u.name, p.day, p.session_type, p.planned_km, p.notes
                FROM plan_days p
                JOIN users u ON u.id = p.user_id
                ORDER BY p.day ASC
                """
            )
        ).mappings().all()

        behavior_metrics = conn.execute(
            text(
                """
                SELECT m.user_id, u.name, m.computed_at, m.window_weeks, m.period_start, m.period_end,
                       m.planned_sessions, m.completed_sessions, m.delayed_sessions, m.long_run_misses,
                       m.planned_km, m.actual_km, m.reliability_score, m.adherence_ratio, m.weekday_success_json
                FROM user_behavior_metrics m
                JOIN users u ON u.id = m.user_id
                ORDER BY m.computed_at DESC
                """
            )
        ).mappings().all()

        behavior_suggestions = conn.execute(
            text(
                """
                SELECT s.user_id, u.name, s.created_at, s.period_start, s.period_end,
                       s.code, s.title, s.reason, s.action, s.status
                FROM user_behavior_suggestions s
                JOIN users u ON u.id = s.user_id
                ORDER BY s.created_at DESC
                """
            )
        ).mappings().all()

        run_feedback = conn.execute(
            text(
                """
                SELECT f.user_id, u.name, f.run_id, r.start_time, f.submitted_at,
                       f.effort, f.fatigue, f.pain, f.session_feel, f.notes
                FROM run_feedback f
                JOIN users u ON u.id = f.user_id
                LEFT JOIN runs r ON r.id = f.run_id
                ORDER BY f.submitted_at DESC
                """
            )
        ).mappings().all()

        achievements = conn.execute(
            text(
                """
                SELECT a.user_id, u.name, a.run_id, a.code, a.title, a.detail, a.created_at
                FROM achievements a
                JOIN users u ON u.id = a.user_id
                ORDER BY a.created_at DESC
                """
            )
        ).mappings().all()

        try:
            pilot_feedback = conn.execute(
                text(
                    """
                    SELECT f.user_id, u.name, f.created_at, f.source, f.category, f.text
                    FROM pilot_feedback f
                    JOIN users u ON u.id = f.user_id
                    ORDER BY f.created_at DESC
                    """
                )
            ).mappings().all()
        except Exception:
            pilot_feedback = []

        try:
            pilot_report = conn.execute(
                text(
                    """
                    WITH ds AS (
                      SELECT user_id, id, run_id, status, started_at
                      FROM device_sessions
                      WHERE date(started_at) >= date('now','-13 day')
                    ),
                    rr AS (
                      SELECT r.id AS run_id, r.distance_m, r.duration_s
                      FROM runs r
                    )
                    SELECT
                      u.id AS user_id,
                      u.name AS name,
                      date('now','-13 day') AS period_start,
                      date('now') AS period_end,
                      COUNT(ds.id) AS sessions_started,
                      SUM(CASE WHEN lower(coalesce(ds.status,''))='completed' THEN 1 ELSE 0 END) AS sessions_completed,
                      SUM(CASE WHEN rf.id IS NOT NULL THEN 1 ELSE 0 END) AS checkins_submitted,
                      ROUND(COALESCE(SUM(rr.distance_m),0)/1000.0,2) AS total_distance_km,
                      ROUND(COALESCE(SUM(rr.duration_s),0)/60.0,1) AS total_motion_min
                    FROM users u
                    LEFT JOIN ds ON ds.user_id = u.id
                    LEFT JOIN rr ON rr.run_id = ds.run_id
                    LEFT JOIN run_feedback rf ON rf.run_id = ds.run_id AND rf.user_id = u.id
                    GROUP BY u.id, u.name
                    ORDER BY u.id
                    """
                )
            ).mappings().all()
        except Exception:
            pilot_report = []

    return {
        "users": users,
        "profiles": profiles,
        "runs": runs,
        "availability": availability,
        "plan_weeks": plan_weeks,
        "plan_days": plan_days,
        "behavior_metrics": behavior_metrics,
        "behavior_suggestions": behavior_suggestions,
        "run_feedback": run_feedback,
        "achievements": achievements,
        "pilot_feedback": pilot_feedback,
        "pilot_report": pilot_report,
    }


def to_users_values(rows: List[dict]) -> List[List[str]]:
    out = [["user_id", "name", "email", "telegram_id", "created_at", "strava_connected"]]
    for r in rows:
        out.append([
            str(r["id"]),
            str(r["name"] or ""),
            str(r["email"] or ""),
            str(r["telegram_id"] or ""),
            str(r["created_at"] or ""),
            str(r["strava_connected"]),
        ])
    return out


def to_profiles_values(rows: List[dict]) -> List[List[str]]:
    out = [[
        "user_id", "name", "goal_mode", "goal_primary", "goal_date", "start_date", "timeline_weeks", "ability_level",
        "weekly_availability", "time_per_run", "recent_runs_per_week",
        "longest_recent_min", "continuous_run_min", "run_walk_ok",
        "injury_status", "preferred_days",
    ]]
    for r in rows:
        out.append([
            str(r["user_id"]),
            str(r["name"] or ""),
            str(r["goal_mode"] or ""),
            str(r["goal_primary"] or ""),
            str(r["goal_date"] or ""),
            str(r["start_date"] or ""),
            str(r["timeline_weeks"] or ""),
            str(r["ability_level"] or ""),
            str(r["weekly_availability"] or ""),
            str(r["time_per_run"] or ""),
            str(r["recent_runs_per_week"] or ""),
            str(r["longest_recent_min"] or ""),
            str(r["continuous_run_min"] or ""),
            str(r["run_walk_ok"] or ""),
            str(r["injury_status"] or ""),
            str(r["preferred_days"] or ""),
        ])
    return out


def to_runs_values(rows: List[dict]) -> List[List[str]]:
    out = [[
        "user_id", "name", "source", "source_id", "start_time", "distance_km", "duration_min", "pace_min_per_km",
    ]]
    for r in rows:
        dist_km = round((r["distance_m"] or 0) / 1000.0, 2)
        duration_min = round((r["duration_s"] or 0) / 60.0, 1)
        pace = ""
        if dist_km > 0:
            pace = f"{round(duration_min / dist_km, 2)}"
        out.append([
            str(r["user_id"]),
            str(r["name"] or ""),
            str(r["source"] or ""),
            str(r["source_id"] or ""),
            str(r["start_time"] or ""),
            str(dist_km),
            str(duration_min),
            pace,
        ])
    return out


def to_availability_values(rows: List[dict]) -> List[List[str]]:
    out = [["user_id", "name", "week_start", "mon", "tue", "wed", "thu", "fri", "sat", "sun"]]
    for r in rows:
        out.append([
            str(r["user_id"]),
            str(r["name"] or ""),
            str(r["week_start"] or ""),
            "Yes" if r["mon"] else "No",
            "Yes" if r["tue"] else "No",
            "Yes" if r["wed"] else "No",
            "Yes" if r["thu"] else "No",
            "Yes" if r["fri"] else "No",
            "Yes" if r["sat"] else "No",
            "Yes" if r["sun"] else "No",
        ])
    return out


def to_plan_weeks_values(rows: List[dict]) -> List[List[str]]:
    out = [["user_id", "name", "week_start", "focus", "target_km"]]
    for r in rows:
        out.append([
            str(r["user_id"]),
            str(r["name"] or ""),
            str(r["week_start"] or ""),
            str(r["focus"] or ""),
            str(r["target_km"] or 0),
        ])
    return out


def to_plan_days_values(rows: List[dict]) -> List[List[str]]:
    out = [["user_id", "name", "day", "session_type", "planned_km", "notes"]]
    for r in rows:
        out.append([
            str(r["user_id"]),
            str(r["name"] or ""),
            str(r["day"] or ""),
            str(r["session_type"] or ""),
            str(r["planned_km"] or 0),
            str(r["notes"] or ""),
        ])
    return out


def to_overview_values(rows: Dict[str, List[dict]]) -> List[List[str]]:
    now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    total_km = round(sum((r["distance_m"] or 0) for r in rows["runs"]) / 1000.0, 2)
    return [
        ["metric", "value"],
        ["last_sync", now_utc],
        ["users", str(len(rows["users"]))],
        ["profiles", str(len(rows["profiles"]))],
        ["runs", str(len(rows["runs"]))],
        ["plan_weeks", str(len(rows["plan_weeks"]))],
        ["plan_days", str(len(rows["plan_days"]))],
        ["total_km", str(total_km)],
        ["availability_rows", str(len(rows["availability"]))],
    ]


def _to_dt(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None


def _to_date(value):
    if value is None:
        return None
    try:
        return datetime.fromisoformat(str(value)).date()
    except Exception:
        try:
            return datetime.strptime(str(value), "%Y-%m-%d").date()
        except Exception:
            return None


def to_coach_dashboard_values(rows: Dict[str, List[dict]]) -> List[List[str]]:
    today = datetime.now().date()
    week_start = today.fromordinal(today.toordinal() - today.weekday())
    last_week_start = week_start.fromordinal(week_start.toordinal() - 7)
    last_week_end = week_start.fromordinal(week_start.toordinal() - 1)

    # Single-user pilot summary. If more users are added later, this still reports global totals.
    run_dates = []
    week_km = 0.0
    last_week_km = 0.0
    total_km = 0.0

    latest_run = None
    for r in rows["runs"]:
        run_dt = _to_dt(r.get("start_time"))
        if run_dt is None:
            continue
        run_date = run_dt.date()
        dist_km = round((r.get("distance_m") or 0) / 1000.0, 2)
        total_km += dist_km
        run_dates.append(run_date)
        if week_start <= run_date <= today:
            week_km += dist_km
        if last_week_start <= run_date <= last_week_end:
            last_week_km += dist_km
        if latest_run is None or run_dt > latest_run["dt"]:
            latest_run = {"dt": run_dt, "km": dist_km, "name": r.get("name") or ""}

    streak = 0
    if run_dates:
        days = sorted(set(run_dates), reverse=True)
        cursor = today
        if days and days[0] < today:
            cursor = days[0]
        day_set = set(days)
        while cursor in day_set:
            streak += 1
            cursor = cursor.fromordinal(cursor.toordinal() - 1)

    next_plan = None
    for p in rows["plan_days"]:
        day = _to_date(p.get("day"))
        if day is None or day < today:
            continue
        if next_plan is None or day < next_plan["day"]:
            next_plan = {
                "day": day,
                "session_type": p.get("session_type") or "",
                "planned_km": p.get("planned_km") or 0,
                "name": p.get("name") or "",
            }

    latest_run_label = "No runs yet"
    if latest_run:
        latest_run_label = (
            f"{latest_run['dt'].strftime('%Y-%m-%d %H:%M')} | "
            f"{latest_run['km']} km | {latest_run['name']}"
        )

    next_plan_label = "No planned run"
    if next_plan:
        next_plan_label = (
            f"{next_plan['day'].isoformat()} | {next_plan['session_type']} | "
            f"{next_plan['planned_km']} km | {next_plan['name']}"
        )

    return [
        ["metric", "value"],
        ["last_sync", datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")],
        ["pilot_mode", "single-user"],
        ["users", str(len(rows["users"]))],
        ["runs_total", str(len(rows["runs"]))],
        ["total_km", str(round(total_km, 2))],
        ["this_week_km", str(round(week_km, 2))],
        ["last_week_km", str(round(last_week_km, 2))],
        ["run_streak_days", str(streak)],
        ["latest_run", latest_run_label],
        ["next_planned_run", next_plan_label],
    ]


def to_behavior_trends_values(rows: List[dict]) -> List[List[str]]:
    def _v(value):
        return "" if value is None else str(value)

    out = [[
        "user_id",
        "name",
        "computed_at",
        "window_weeks",
        "period_start",
        "period_end",
        "planned_sessions",
        "completed_sessions",
        "delayed_sessions",
        "long_run_misses",
        "planned_km",
        "actual_km",
        "reliability_score",
        "adherence_ratio",
        "weekday_success_json",
    ]]
    for r in rows:
        out.append([
            _v(r["user_id"]),
            _v(r["name"]),
            _v(r["computed_at"]),
            _v(r["window_weeks"]),
            _v(r["period_start"]),
            _v(r["period_end"]),
            _v(r["planned_sessions"]),
            _v(r["completed_sessions"]),
            _v(r["delayed_sessions"]),
            _v(r["long_run_misses"]),
            _v(r["planned_km"]),
            _v(r["actual_km"]),
            _v(r["reliability_score"]),
            _v(r["adherence_ratio"]),
            _v(r["weekday_success_json"] or "{}"),
        ])
    return out


def to_behavior_suggestions_values(rows: List[dict]) -> List[List[str]]:
    out = [[
        "user_id",
        "name",
        "created_at",
        "period_start",
        "period_end",
        "code",
        "title",
        "reason",
        "action",
        "status",
    ]]
    for r in rows:
        out.append([
            str(r["user_id"]),
            str(r["name"] or ""),
            str(r["created_at"] or ""),
            str(r["period_start"] or ""),
            str(r["period_end"] or ""),
            str(r["code"] or ""),
            str(r["title"] or ""),
            str(r["reason"] or ""),
            str(r["action"] or ""),
            str(r["status"] or ""),
        ])
    return out


def to_run_feedback_values(rows: List[dict]) -> List[List[str]]:
    out = [[
        "user_id",
        "name",
        "run_id",
        "run_start_time",
        "submitted_at",
        "effort",
        "fatigue",
        "pain",
        "session_feel",
        "notes",
    ]]
    for r in rows:
        out.append([
            str(r["user_id"]),
            str(r["name"] or ""),
            str(r["run_id"] or ""),
            str(r["start_time"] or ""),
            str(r["submitted_at"] or ""),
            str(r["effort"] or ""),
            str(r["fatigue"] or ""),
            str(r["pain"] or ""),
            str(r["session_feel"] or ""),
            str(r["notes"] or ""),
        ])
    return out


def to_achievements_values(rows: List[dict]) -> List[List[str]]:
    out = [[
        "user_id",
        "name",
        "run_id",
        "code",
        "title",
        "detail",
        "created_at",
    ]]
    for r in rows:
        out.append([
            str(r["user_id"]),
            str(r["name"] or ""),
            str(r["run_id"] or ""),
            str(r["code"] or ""),
            str(r["title"] or ""),
            str(r["detail"] or ""),
            str(r["created_at"] or ""),
        ])
    return out


def to_pilot_feedback_values(rows: List[dict]) -> List[List[str]]:
    out = [["user_id", "name", "created_at", "source", "category", "text"]]
    for r in rows:
        out.append([
            str(r["user_id"]),
            str(r["name"] or ""),
            str(r["created_at"] or ""),
            str(r["source"] or ""),
            str(r["category"] or ""),
            str(r["text"] or ""),
        ])
    return out


def to_pilot_report_values(rows: List[dict]) -> List[List[str]]:
    out = [[
        "user_id",
        "name",
        "period_start",
        "period_end",
        "sessions_started",
        "sessions_completed",
        "checkins_submitted",
        "total_distance_km",
        "total_motion_min",
    ]]
    for r in rows:
        out.append([
            str(r.get("user_id") or ""),
            str(r.get("name") or ""),
            str(r.get("period_start") or ""),
            str(r.get("period_end") or ""),
            str(r.get("sessions_started") or 0),
            str(r.get("sessions_completed") or 0),
            str(r.get("checkins_submitted") or 0),
            str(r.get("total_distance_km") or 0),
            str(r.get("total_motion_min") or 0),
        ])
    return out


def main() -> None:
    cfg = load_settings()
    creds_file = cfg["creds_file"]
    sheet_id = cfg["sheet_id"]

    if not Path(creds_file).exists():
        raise SystemExit(f"Google Sheets credentials not found: {creds_file}")

    rows = fetch_rows(cfg["database_url"])
    service = get_sheets_service(creds_file)

    tabs = [
        "Overview",
        "Coach Dashboard",
        "Users",
        "Profiles",
        "Runs",
        "Availability",
        "Plan Weeks",
        "Plan Days",
        "Behavior Trends",
        "Behavior Suggestions",
        "Run Feedback",
        "Achievements",
        "Pilot Feedback",
        "Pilot Report",
    ]
    ensure_tabs(service, sheet_id, tabs)

    write_tab(service, sheet_id, "Overview", to_overview_values(rows))
    write_tab(service, sheet_id, "Coach Dashboard", to_coach_dashboard_values(rows))
    write_tab(service, sheet_id, "Users", to_users_values(rows["users"]))
    write_tab(service, sheet_id, "Profiles", to_profiles_values(rows["profiles"]))
    write_tab(service, sheet_id, "Runs", to_runs_values(rows["runs"]))
    write_tab(service, sheet_id, "Availability", to_availability_values(rows["availability"]))
    write_tab(service, sheet_id, "Plan Weeks", to_plan_weeks_values(rows["plan_weeks"]))
    write_tab(service, sheet_id, "Plan Days", to_plan_days_values(rows["plan_days"]))
    write_tab(service, sheet_id, "Behavior Trends", to_behavior_trends_values(rows["behavior_metrics"]))
    write_tab(
        service,
        sheet_id,
        "Behavior Suggestions",
        to_behavior_suggestions_values(rows["behavior_suggestions"]),
    )
    write_tab(service, sheet_id, "Run Feedback", to_run_feedback_values(rows["run_feedback"]))
    write_tab(service, sheet_id, "Achievements", to_achievements_values(rows["achievements"]))
    write_tab(service, sheet_id, "Pilot Feedback", to_pilot_feedback_values(rows["pilot_feedback"]))
    write_tab(service, sheet_id, "Pilot Report", to_pilot_report_values(rows["pilot_report"]))

    log(f"Synced Google Sheet: {sheet_id}")


if __name__ == "__main__":
    main()
