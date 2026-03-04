from __future__ import annotations

import json
import os
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app import models, schemas
from app.deps import get_db

router = APIRouter(prefix="/plans", tags=["plans"])

DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
GOAL_PEAK_KM = {
    "get moving": 12,
    "5k": 25,
    "10k": 35,
    "half": 50,
    "marathon": 70,
    "ultra/other": 85,
}
GOAL_LONG_MIN_KM = {
    "get moving": 4,
    "5k": 8,
    "10k": 10,
    "half": 14,
    "marathon": 18,
    "ultra/other": 22,
}
C25K_STEPS = [
    (1.0, 1.5, 8),
    (1.5, 2.0, 7),
    (2.0, 2.0, 6),
    (3.0, 2.0, 5),
    (5.0, 2.0, 4),
    (8.0, 2.0, 3),
    (10.0, 2.0, 3),
    (15.0, 1.0, 2),
    (20.0, 0.0, 1),
    (25.0, 0.0, 1),
    (30.0, 0.0, 1),
    (30.0, 0.0, 1),
]
C25K_WEEKLY_MOTION_MIN = [90, 100, 110, 120, 130, 140, 150, 165, 180, 195, 210, 225]


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name, "")
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "")
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


TAPER_WEEK_1_MULT = _env_float("PLAN_TAPER_WEEK_1_MULT", 0.8)
TAPER_WEEK_2_MULT = _env_float("PLAN_TAPER_WEEK_2_MULT", 0.6)
RECOVERY_WEEK_MULT = _env_float("PLAN_RECOVERY_WEEK_MULT", 0.82)
OVERREACH_WEEK_MULT = _env_float("PLAN_OVERREACH_WEEK_MULT", 1.06)
INJURY_RETURNING_MULT = _env_float("PLAN_INJURY_RETURNING_MULT", 0.8)
INJURY_ONGOING_MULT = _env_float("PLAN_INJURY_ONGOING_MULT", 0.65)
LONG_RUN_RATIO = _env_float("PLAN_LONG_RUN_RATIO", 0.38)
LONG_RUN_RATIO_INJURY = _env_float("PLAN_LONG_RUN_RATIO_INJURY", 0.30)
LONG_RUN_CAP_RATIO = _env_float("PLAN_LONG_RUN_CAP_RATIO", 0.60)
QUALITY_RUN_RATIO = _env_float("PLAN_QUALITY_RUN_RATIO", 0.22)
ONGOING_MAX_RUN_DAYS = _env_int("PLAN_ONGOING_MAX_RUN_DAYS", 3)
RETURNING_MAX_RUN_DAYS = _env_int("PLAN_RETURNING_MAX_RUN_DAYS", 4)


def _week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _parse_preferred_days(preferred_days: str) -> list[int]:
    text = (preferred_days or "").lower()
    explicit = []
    for idx, day in enumerate(DAY_LABELS):
        if day.lower() in text:
            explicit.append(idx)
    if explicit:
        return sorted(set(explicit))
    if "mon/wed/fri" in text:
        return [0, 2, 4]
    if "tue/thu/sat" in text:
        return [1, 3, 5]
    return [1, 3, 6]


def _default_run_km(ability_level: str) -> int:
    level = (ability_level or "").lower()
    if "experienced" in level:
        return 9
    if "3x-week" in level:
        return 7
    if "occasional" in level:
        return 5
    return 3


def _parse_time_cap_minutes(time_per_run: str) -> int:
    text = (time_per_run or "").lower()
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
    # Legacy labels fallback.
    if "20" in text and "30" in text:
        return 30
    return 60


def _easy_pace_min_per_km(ability_level: str) -> float:
    level = (ability_level or "").lower()
    if "experienced" in level:
        return 5.3
    if "3x-week" in level:
        return 5.8
    if "occasional" in level:
        return 6.3
    return 7.2


def _is_beginner_path(profile: models.Profile, goal: str) -> bool:
    ability = (profile.ability_level or "").lower()
    continuous = profile.continuous_run_min
    recent = profile.recent_runs_per_week
    run_walk_ok = str(profile.run_walk_ok or "").lower().startswith("y")
    low_goal = goal in {"get moving", "5k"}
    return (
        "new" in ability
        or (continuous is not None and continuous <= 10)
        or (recent is not None and recent <= 1)
        or (low_goal and run_walk_ok)
    )


def _c25k_motion_target(week_index: int) -> int:
    return C25K_WEEKLY_MOTION_MIN[min(week_index, len(C25K_WEEKLY_MOTION_MIN) - 1)]


def _build_c25k_sessions(
    run_days: list[int],
    week_index: int,
    ability_level: str,
) -> tuple[dict[int, tuple[str, int, Optional[str]]], int]:
    sessions: dict[int, tuple[str, int, Optional[str]]] = {}
    if not run_days:
        return sessions, 0
    run_days = sorted(run_days)[:3]
    run_min, walk_min, _ = C25K_STEPS[min(week_index, len(C25K_STEPS) - 1)]
    week_motion_target = _c25k_motion_target(week_index)
    session_motion_target = max(25, int(round(week_motion_target / max(1, len(run_days)))))
    warmup = 5.0
    cooldown = 5.0
    cycle_min = max(1.0, run_min + walk_min)
    motion_core = max(10.0, session_motion_target - warmup - cooldown)
    repeats = max(1, int(round(motion_core / cycle_min)))
    total_min = warmup + cooldown + (repeats * cycle_min)
    # C25K pilot is motion-first; keep distance intentionally low to avoid pressure.
    est_km = 1
    note = (
        f"C25K|warmup={warmup}|run={run_min}|walk={walk_min}|repeats={repeats}|cooldown={cooldown}"
        f"|session_min={round(total_min,1)}|week_motion_min={week_motion_target}"
    )
    for d in run_days:
        sessions[d] = ("C25K Run/Walk", est_km, note)
    return sessions, week_motion_target


def _goal_key(goal_primary: str) -> str:
    text = (goal_primary or "").strip().lower()
    if text in GOAL_PEAK_KM:
        return text
    if "5k" in text:
        return "5k"
    if "10k" in text:
        return "10k"
    if "half" in text:
        return "half"
    if "marathon" in text:
        return "marathon"
    if "ultra" in text:
        return "ultra/other"
    return "get moving"


def _injury_mode(injury_status: str) -> str:
    text = (injury_status or "").lower()
    if "ongoing" in text:
        return "ongoing"
    if "returning" in text:
        return "returning"
    return "none"


def _recent_weekly_km(db: Session, user_id: int, today: date) -> float:
    start = datetime.combine(today - timedelta(days=28), datetime.min.time())
    rows = (
        db.query(models.Run.distance_m)
        .filter(models.Run.user_id == user_id, models.Run.start_time >= start)
        .all()
    )
    total_m = sum(int(r[0] or 0) for r in rows)
    return round((total_m / 1000.0) / 4.0, 2)


def _timeline_weeks(profile: models.Profile, weeks: int) -> int:
    if profile.goal_date:
        delta_days = (profile.goal_date - date.today()).days
        if delta_days > 0:
            computed = max(4, min(52, int(round(delta_days / 7.0))))
            return min(computed, weeks)
    if profile.timeline_weeks and profile.timeline_weeks > 0:
        return min(max(profile.timeline_weeks, 4), weeks)
    return weeks


def _week_factor(week_index: int, horizon: int) -> float:
    # 3:1 build/recover rhythm with mild taper in final 2 weeks.
    if week_index >= horizon - 2:
        return 0.85
    cycle = week_index % 4
    if cycle == 3:
        return 0.8
    if cycle == 2:
        return 1.1
    if cycle == 1:
        return 1.05
    return 1.0


def _goal_week_target(
    week_index: int,
    horizon: int,
    start_km: float,
    peak_km: int,
    injury_mode: str,
) -> int:
    if horizon <= 1:
        base = start_km
    else:
        build_weeks = max(1, horizon - 2)
        if week_index >= build_weeks:
            # 2-week taper.
            taper_mult = TAPER_WEEK_1_MULT if week_index == build_weeks else TAPER_WEEK_2_MULT
            base = peak_km * taper_mult
        else:
            progress = week_index / max(1, build_weeks - 1)
            base = start_km + ((peak_km - start_km) * progress)
            cycle = week_index % 4
            if cycle == 3:
                base *= RECOVERY_WEEK_MULT  # recovery week
            elif cycle == 2:
                base *= OVERREACH_WEEK_MULT  # slight overreach

    if injury_mode == "returning":
        base *= INJURY_RETURNING_MULT
    elif injury_mode == "ongoing":
        base *= INJURY_ONGOING_MULT
    return max(8, int(round(base)))


def _available_days_for_week(
    preferred: list[int],
    weekly_availability: Optional[models.WeeklyAvailability],
) -> list[int]:
    if weekly_availability is None:
        return preferred
    allowed_all = [i for i, key in enumerate(DAY_KEYS) if getattr(weekly_availability, key)]
    if not allowed_all:
        return []
    preferred_allowed = [d for d in preferred if d in allowed_all]
    return preferred_allowed or allowed_all


def _build_sessions(
    run_days: list[int],
    week_target: int,
    goal: str,
    injury_mode: str,
) -> dict[int, tuple[str, int, Optional[str]]]:
    sessions: dict[int, tuple[str, int, Optional[str]]] = {}
    if not run_days:
        return sessions

    total_runs = len(run_days)
    long_min = GOAL_LONG_MIN_KM[goal]
    quality_allowed = injury_mode == "none" and total_runs >= 3
    long_ratio = LONG_RUN_RATIO if injury_mode == "none" else LONG_RUN_RATIO_INJURY
    long_km = int(round(week_target * long_ratio))
    long_km = max(long_min, min(long_km, int(round(week_target * LONG_RUN_CAP_RATIO))))

    quality_km = 0
    if quality_allowed:
        quality_km = max(4, int(round(week_target * QUALITY_RUN_RATIO)))

    easy_runs = total_runs - 1 - (1 if quality_allowed else 0)
    easy_pool = max(0, week_target - long_km - quality_km)
    easy_km = max(2, int(round(easy_pool / max(1, easy_runs))))

    long_day = run_days[-1]
    sessions[long_day] = (
        "Long Run" if injury_mode == "none" else "Long Easy Run",
        long_km,
        "Deloaded for injury status." if injury_mode != "none" else None,
    )

    quality_day = run_days[1] if quality_allowed else None
    if quality_day is not None:
        sessions[quality_day] = ("Quality Run", quality_km, None)

    for d in run_days:
        if d in sessions:
            continue
        note = "Keep effort low while returning." if injury_mode != "none" else None
        sessions[d] = ("Easy Run", easy_km, note)

    # Keep weekly sum close to target.
    diff = week_target - sum(km for _, km, _ in sessions.values())
    if diff != 0:
        label, km, note = sessions[long_day]
        sessions[long_day] = (label, max(2, km + diff), note)
    return sessions


@router.post("/generate/{user_id}", response_model=schemas.PlanGenerateOut)
def generate_plan(
    user_id: int,
    weeks: int = Query(16, ge=4, le=52),
    db: Session = Depends(get_db),
):
    user = db.get(models.User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if not user.profile:
        user.profile = models.Profile(
            user_id=user_id,
            goal_mode="Build up to run a distance continuously",
            goal_primary="5K",
            goal_date=None,
            start_date=date.today(),
            timeline_weeks=12,
            ability_level="New",
            weekly_availability=3,
            time_per_run="Up to 45 min",
            recent_runs_per_week=0,
            longest_recent_min=0,
            continuous_run_min=5,
            run_walk_ok="Yes",
            injury_status="None",
            preferred_days="Mon/Tue/Wed/Thu/Fri/Sat/Sun",
        )
        db.add(user.profile)
        db.commit()
        db.refresh(user)

    profile = user.profile
    today = date.today()
    start_anchor = profile.start_date if profile.start_date and profile.start_date > today else today
    start = _week_start(start_anchor)
    horizon = _timeline_weeks(profile, weeks)
    preferred = _parse_preferred_days(profile.preferred_days)
    injury_mode = _injury_mode(profile.injury_status)
    goal = _goal_key(profile.goal_primary)
    beginner_path = _is_beginner_path(profile, goal)
    runs_per_week = max(2, min(profile.weekly_availability, 6))
    if beginner_path:
        runs_per_week = min(runs_per_week, 3)
    if injury_mode == "ongoing":
        runs_per_week = min(runs_per_week, ONGOING_MAX_RUN_DAYS)
    elif injury_mode == "returning":
        runs_per_week = min(runs_per_week, RETURNING_MAX_RUN_DAYS)

    baseline_weekly = _recent_weekly_km(db, user_id, today)
    if baseline_weekly <= 0:
        baseline_weekly = _default_run_km(profile.ability_level) * runs_per_week
    peak_km = GOAL_PEAK_KM[goal]
    start_km = max(8, min(peak_km * 0.8, baseline_weekly))

    # Reset existing generated horizon for deterministic recalculation.
    end = start + timedelta(days=(horizon * 7) - 1)
    db.query(models.PlanDay).filter(
        models.PlanDay.user_id == user_id,
        models.PlanDay.day >= start,
        models.PlanDay.day <= end,
    ).delete(synchronize_session=False)
    db.query(models.PlanWeek).filter(
        models.PlanWeek.user_id == user_id,
        models.PlanWeek.week_start >= start,
        models.PlanWeek.week_start <= _week_start(end),
    ).delete(synchronize_session=False)
    # Remove stale future plan rows beyond the new horizon.
    db.query(models.PlanDay).filter(
        models.PlanDay.user_id == user_id,
        models.PlanDay.day > end,
    ).delete(synchronize_session=False)
    db.query(models.PlanWeek).filter(
        models.PlanWeek.user_id == user_id,
        models.PlanWeek.week_start > _week_start(end),
    ).delete(synchronize_session=False)
    db.commit()

    total_days = 0
    for w in range(horizon):
        week_start = start + timedelta(days=7 * w)
        week_factor = _week_factor(w, horizon)
        week_target = _goal_week_target(w, horizon, start_km, peak_km, injury_mode)
        week_target = max(8, int(round(week_target * week_factor)))
        availability = (
            db.query(models.WeeklyAvailability)
            .filter_by(user_id=user_id, week_start=week_start)
            .first()
        )
        desired_runs = runs_per_week
        run_days = _available_days_for_week(preferred, availability)
        if availability is None:
            run_days = run_days[:desired_runs]
            if len(run_days) < desired_runs:
                for d in range(7):
                    if d not in run_days:
                        run_days.append(d)
                    if len(run_days) == desired_runs:
                        break
        else:
            run_days = run_days[:desired_runs]
            available_count = len(run_days)
            if available_count == 0:
                week_target = 0
            elif available_count < desired_runs:
                week_target = max(4, int(round(week_target * (available_count / float(desired_runs)))))
        run_days = sorted(run_days)
        if w == 0 and profile.start_date:
            start_wd = profile.start_date.weekday()
            if availability is None or getattr(availability, DAY_KEYS[start_wd]):
                if start_wd not in run_days:
                    run_days = [start_wd] + run_days
                    run_days = sorted(run_days)[:desired_runs]
        if w == 0 and profile.start_date and profile.start_date > week_start:
            run_days = [d for d in run_days if (week_start + timedelta(days=d)) >= profile.start_date]
        pace_min_per_km = _easy_pace_min_per_km(profile.ability_level)
        time_cap_min = _parse_time_cap_minutes(profile.time_per_run)
        per_run_cap_km = max(2, int(time_cap_min / max(4.5, pace_min_per_km)))
        if run_days:
            feasible_week_km = per_run_cap_km * len(run_days)
            if feasible_week_km < week_target:
                week_target = feasible_week_km

        week = models.PlanWeek(
            user_id=user_id,
            week_start=week_start,
            focus=("C25K Build" if beginner_path else ("Recovery" if (w % 4) == 3 else "Build")),
            target_km=week_target,
        )
        db.add(week)

        if beginner_path:
            run_day_map, c25k_total = _build_c25k_sessions(run_days, w, profile.ability_level)
            week.target_km = max(0, c25k_total)
        else:
            run_day_map = _build_sessions(run_days, week_target, goal, injury_mode)
            if per_run_cap_km > 0:
                for d_idx, (session, km, note) in list(run_day_map.items()):
                    if km > per_run_cap_km:
                        extra_note = f"Capped to fit your max {time_cap_min} min/run setting."
                        run_day_map[d_idx] = (
                            session,
                            per_run_cap_km,
                            f"{note} {extra_note}".strip() if note else extra_note,
                        )
                week.target_km = sum(km for _, km, _ in run_day_map.values())

        # Persist full-date horizon: run days + explicit rest days.
        for d in range(7):
            session, km, note = run_day_map.get(d, ("Rest", 0, None))
            plan_day = models.PlanDay(
                user_id=user_id,
                day=week_start + timedelta(days=d),
                session_type=session,
                planned_km=km,
                notes=note,
            )
            db.add(plan_day)
            total_days += 1

    db.commit()
    return {
        "weeks": horizon,
        "days": total_days,
        "start_date": start,
        "end_date": end,
    }


@router.get("/day/{user_id}", response_model=schemas.PlanDayOut)
def get_plan_day(user_id: int, day: date = Query(...), db: Session = Depends(get_db)):
    row = db.query(models.PlanDay).filter_by(user_id=user_id, day=day).first()
    if not row:
        raise HTTPException(status_code=404, detail="No planned run for this date")
    return row


@router.get("/week/{user_id}", response_model=schemas.PlanWeekViewOut)
def get_plan_week(
    user_id: int,
    week_start: date = Query(...),
    db: Session = Depends(get_db),
):
    week = db.query(models.PlanWeek).filter_by(user_id=user_id, week_start=week_start).first()
    days = (
        db.query(models.PlanDay)
        .filter(
            models.PlanDay.user_id == user_id,
            models.PlanDay.day >= week_start,
            models.PlanDay.day <= week_start + timedelta(days=6),
        )
        .order_by(models.PlanDay.day.asc())
        .all()
    )
    if not week and not days:
        raise HTTPException(status_code=404, detail="No plan found for that week")

    return {
        "week_start": week_start,
        "focus": week.focus if week else "Planned",
        "target_km": week.target_km if week else sum(d.planned_km for d in days),
        "days": days,
    }


def _review_adjustment_factor(adherence_ratio: float) -> float:
    if adherence_ratio < 0.5:
        return 0.85
    if adherence_ratio < 0.75:
        return 0.93
    if adherence_ratio > 1.15:
        return 1.08
    if adherence_ratio > 1.0:
        return 1.03
    return 1.0


def _rescale_next_week_days(
    days: list[models.PlanDay],
    factor: float,
    desired_total_km: int,
) -> None:
    run_days = [d for d in days if d.session_type.lower() != "rest" and d.planned_km > 0]
    if not run_days:
        return

    for d in run_days:
        d.planned_km = max(1, int(round(d.planned_km * factor)))

    current_total = sum(d.planned_km for d in run_days)
    diff = desired_total_km - current_total
    if diff != 0:
        anchor = max(run_days, key=lambda x: x.planned_km)
        anchor.planned_km = max(1, anchor.planned_km + diff)


def _weekday_best_and_worst(weekday_success: dict[int, float]) -> tuple[Optional[int], Optional[int]]:
    populated = [(d, v) for d, v in weekday_success.items() if v >= 0]
    if not populated:
        return None, None
    best = max(populated, key=lambda x: x[1])[0]
    worst = min(populated, key=lambda x: x[1])[0]
    return best, worst


def _match_planned_sessions_to_runs(
    planned_run_days: list[date],
    run_dates: list[date],
    grace_days: int = 2,
) -> tuple[int, int]:
    # Greedy assignment: each run can satisfy at most one planned session.
    # A planned session is considered completed if matched on the same day or within grace_days after.
    used = [False] * len(run_dates)
    completed = 0
    delayed = 0
    for plan_day in sorted(planned_run_days):
        match_idx = None
        for i, run_day in enumerate(run_dates):
            if used[i]:
                continue
            if plan_day <= run_day <= (plan_day + timedelta(days=grace_days)):
                match_idx = i
                break
        if match_idx is None:
            continue
        used[match_idx] = True
        completed += 1
        if run_dates[match_idx] > plan_day:
            delayed += 1
    return completed, delayed


def _shift_run_from_worst_to_best(
    next_days: list[models.PlanDay],
    worst_weekday: Optional[int],
    best_weekday: Optional[int],
) -> Optional[str]:
    if worst_weekday is None or best_weekday is None or worst_weekday == best_weekday:
        return None

    by_weekday = {d.day.weekday(): d for d in next_days}
    from_day = by_weekday.get(worst_weekday)
    to_day = by_weekday.get(best_weekday)
    if not from_day or not to_day:
        return None
    if from_day.session_type.lower() == "rest" or from_day.planned_km <= 0:
        return None
    if to_day.session_type.lower() != "rest" or to_day.planned_km != 0:
        return None

    to_day.session_type = from_day.session_type
    to_day.planned_km = from_day.planned_km
    to_day.notes = (to_day.notes or "") + " Shifted from low-adherence day."
    from_day.session_type = "Rest"
    from_day.planned_km = 0
    from_day.notes = (from_day.notes or "") + " Shifted to higher-adherence day."
    return f"Shifted one run from {DAY_LABELS[worst_weekday]} to {DAY_LABELS[best_weekday]}."


@router.post("/review/{user_id}", response_model=schemas.PlanReviewOut)
def review_week_and_adjust_next(
    user_id: int,
    week_start: Optional[date] = Query(None),
    apply_adjustment: bool = Query(True),
    db: Session = Depends(get_db),
):
    target_week = week_start or (_week_start(date.today()) - timedelta(days=7))

    def _load_planned_days(wk: date) -> list[models.PlanDay]:
        return (
            db.query(models.PlanDay)
            .filter(
                models.PlanDay.user_id == user_id,
                models.PlanDay.day >= wk,
                models.PlanDay.day <= wk + timedelta(days=6),
            )
            .order_by(models.PlanDay.day.asc())
            .all()
        )

    planned_days = _load_planned_days(target_week)
    if not planned_days and week_start is None:
        # Fresh users may only have current/future plan rows.
        target_week = _week_start(date.today())
        planned_days = _load_planned_days(target_week)
    if not planned_days:
        raise HTTPException(status_code=404, detail="No plan found for review week")
    week_end = target_week + timedelta(days=6)

    planned_km = round(sum(float(d.planned_km or 0) for d in planned_days), 2)
    planned_sessions = sum(
        1 for d in planned_days if d.session_type.lower() != "rest" and (d.planned_km or 0) > 0
    )

    run_rows = (
        db.query(models.Run.start_time, models.Run.distance_m)
        .filter(
            models.Run.user_id == user_id,
            models.Run.start_time >= datetime.combine(target_week, datetime.min.time()),
            models.Run.start_time < datetime.combine(week_end + timedelta(days=1), datetime.min.time()),
        )
        .all()
    )
    actual_km = round(sum(float(r[1] or 0) for r in run_rows) / 1000.0, 2)
    run_dates = sorted([r[0].date() for r in run_rows])
    planned_run_days = [
        d.day
        for d in planned_days
        if d.session_type.lower() != "rest" and (d.planned_km or 0) > 0
    ]
    completed_sessions, _ = _match_planned_sessions_to_runs(planned_run_days, run_dates)
    missed_sessions = max(0, planned_sessions - completed_sessions)
    adherence_ratio = round((actual_km / planned_km), 3) if planned_km > 0 else 1.0

    adjustment_factor = _review_adjustment_factor(adherence_ratio)
    next_week_start = target_week + timedelta(days=7)
    next_week = db.query(models.PlanWeek).filter_by(user_id=user_id, week_start=next_week_start).first()
    if not next_week:
        raise HTTPException(status_code=404, detail="No next-week plan to adjust")

    old_target = int(next_week.target_km or 0)
    new_target = old_target
    if apply_adjustment:
        new_target = max(8, int(round(old_target * adjustment_factor)))
        next_week.target_km = new_target
        next_days = (
            db.query(models.PlanDay)
            .filter(
                models.PlanDay.user_id == user_id,
                models.PlanDay.day >= next_week_start,
                models.PlanDay.day <= next_week_start + timedelta(days=6),
            )
            .all()
        )
        _rescale_next_week_days(next_days, adjustment_factor, new_target)
        db.commit()

    return {
        "user_id": user_id,
        "week_start": target_week,
        "planned_km": planned_km,
        "actual_km": actual_km,
        "adherence_ratio": adherence_ratio,
        "planned_sessions": planned_sessions,
        "completed_sessions": completed_sessions,
        "missed_sessions": missed_sessions,
        "adjustment_factor": adjustment_factor,
        "next_week_start": next_week_start,
        "old_next_week_target_km": old_target,
        "new_next_week_target_km": new_target,
    }


@router.post("/behavior/{user_id}", response_model=schemas.BehaviorAnalysisOut)
def analyze_behavior(
    user_id: int,
    window_weeks: int = Query(6, ge=2, le=12),
    apply_suggestions: bool = Query(False),
    persist: bool = Query(True),
    db: Session = Depends(get_db),
):
    user = db.get(models.User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    current_week = _week_start(date.today())
    period_end = current_week - timedelta(days=1)
    period_start = current_week - timedelta(days=window_weeks * 7)

    planned_days = (
        db.query(models.PlanDay)
        .filter(
            models.PlanDay.user_id == user_id,
            models.PlanDay.day >= period_start,
            models.PlanDay.day <= period_end,
        )
        .all()
    )
    if not planned_days:
        first_plan = (
            db.query(models.PlanDay.day)
            .filter(models.PlanDay.user_id == user_id)
            .order_by(models.PlanDay.day.asc())
            .first()
        )
        if first_plan:
            period_start = first_plan[0]
            period_end = min(date.today(), period_start + timedelta(days=(window_weeks * 7) - 1))
            planned_days = (
                db.query(models.PlanDay)
                .filter(
                    models.PlanDay.user_id == user_id,
                    models.PlanDay.day >= period_start,
                    models.PlanDay.day <= period_end,
                )
                .all()
            )

    run_rows = (
        db.query(models.Run.start_time, models.Run.distance_m)
        .filter(
            models.Run.user_id == user_id,
            models.Run.start_time >= datetime.combine(period_start, datetime.min.time()),
            models.Run.start_time < datetime.combine(period_end + timedelta(days=1), datetime.min.time()),
        )
        .all()
    )

    run_dates = sorted([r[0].date() for r in run_rows])
    run_set = set(run_dates)

    planned_sessions = 0
    completed_sessions = 0
    delayed_sessions = 0
    long_run_misses = 0
    planned_km = 0.0
    weekday_planned: dict[int, int] = defaultdict(int)
    weekday_done: dict[int, int] = defaultdict(int)
    planned_run_days: list[date] = []

    for d in planned_days:
        planned_km += float(d.planned_km or 0)
        is_run = d.session_type.lower() != "rest" and (d.planned_km or 0) > 0
        if not is_run:
            continue
        planned_run_days.append(d.day)
        planned_sessions += 1
        wd = d.day.weekday()
        weekday_planned[wd] += 1
        if "long" in d.session_type.lower():
            # Count as missed for now; corrected after matching.
            long_run_misses += 1

    completed_sessions, delayed_sessions = _match_planned_sessions_to_runs(planned_run_days, run_dates)

    # Weekday success should reflect exact-day completion for that weekday.
    for pd in planned_run_days:
        if pd in run_set:
            weekday_done[pd.weekday()] += 1

    # Recompute long-run misses precisely: missed planned long sessions not matched within grace window.
    long_run_misses = 0
    long_days = [
        d.day
        for d in planned_days
        if "long" in d.session_type.lower() and d.session_type.lower() != "rest" and (d.planned_km or 0) > 0
    ]
    long_completed, _ = _match_planned_sessions_to_runs(long_days, run_dates)
    long_run_misses = max(0, len(long_days) - long_completed)

    actual_km = round(sum(float(r[1] or 0) for r in run_rows) / 1000.0, 2)
    planned_km = round(planned_km, 2)
    reliability_score = round((completed_sessions / planned_sessions), 3) if planned_sessions else 0.0
    adherence_ratio = round((actual_km / planned_km), 3) if planned_km > 0 else 0.0

    weekday_success_raw: dict[int, float] = {}
    weekday_success: dict[str, float] = {}
    for idx, name in enumerate(DAY_LABELS):
        p = weekday_planned.get(idx, 0)
        s = round((weekday_done.get(idx, 0) / p), 3) if p else -1.0
        weekday_success_raw[idx] = s
        weekday_success[name] = s

    suggestions: list[dict] = []
    best_day, worst_day = _weekday_best_and_worst(weekday_success_raw)
    if worst_day is not None and weekday_success_raw.get(worst_day, -1.0) >= 0:
        worst_rate = weekday_success_raw[worst_day]
        worst_planned = weekday_planned.get(worst_day, 0)
        if worst_planned >= 3 and worst_rate < 0.5 and best_day is not None:
            suggestions.append(
                {
                    "code": "day_reallocation",
                    "title": "Reallocate low-success weekday",
                    "reason": (
                        f"{DAY_LABELS[worst_day]} has low completion ({int(worst_rate * 100)}%) "
                        f"across {worst_planned} planned sessions."
                    ),
                    "action": (
                        f"Move one session from {DAY_LABELS[worst_day]} to "
                        f"{DAY_LABELS[best_day]} next week."
                    ),
                }
            )

    if planned_sessions >= 4 and (delayed_sessions / planned_sessions) >= 0.3:
        suggestions.append(
            {
                "code": "schedule_shift",
                "title": "Shift schedule later",
                "reason": "A high share of sessions are completed 1-2 days late.",
                "action": "Offer a shifted plan so planned days better match actual behavior.",
            }
        )

    if long_run_misses >= 2:
        suggestions.append(
            {
                "code": "split_long_run",
                "title": "Split long run",
                "reason": "Long runs are repeatedly missed.",
                "action": "Replace one long run with two medium runs on adjacent days.",
            }
        )

    if reliability_score >= 0.85 and 0.9 <= adherence_ratio <= 1.15:
        suggestions.append(
            {
                "code": "progressive_overload",
                "title": "Progress load carefully",
                "reason": "Consistency and adherence are strong.",
                "action": "Increase next week's target by 3-5% if recovery remains good.",
            }
        )

    if persist and (planned_sessions > 0 or planned_km > 0):
        db.query(models.UserBehaviorMetric).filter(
            models.UserBehaviorMetric.user_id == user_id,
            models.UserBehaviorMetric.window_weeks == window_weeks,
            models.UserBehaviorMetric.period_start == period_start,
            models.UserBehaviorMetric.period_end == period_end,
        ).delete(synchronize_session=False)
        db.query(models.UserBehaviorSuggestion).filter(
            models.UserBehaviorSuggestion.user_id == user_id,
            models.UserBehaviorSuggestion.period_start == period_start,
            models.UserBehaviorSuggestion.period_end == period_end,
        ).delete(synchronize_session=False)

        metric = models.UserBehaviorMetric(
            user_id=user_id,
            window_weeks=window_weeks,
            period_start=period_start,
            period_end=period_end,
            planned_sessions=planned_sessions,
            completed_sessions=completed_sessions,
            planned_km=planned_km,
            actual_km=actual_km,
            reliability_score=reliability_score,
            adherence_ratio=adherence_ratio,
            delayed_sessions=delayed_sessions,
            long_run_misses=long_run_misses,
            weekday_success_json=json.dumps(weekday_success),
        )
        db.add(metric)

        for s in suggestions:
            db.add(
                models.UserBehaviorSuggestion(
                    user_id=user_id,
                    period_start=period_start,
                    period_end=period_end,
                    code=s["code"],
                    title=s["title"],
                    reason=s["reason"],
                    action=s["action"],
                    status="proposed",
                )
            )

    applied_actions: list[str] = []
    if apply_suggestions:
        next_week_start = current_week
        next_days = (
            db.query(models.PlanDay)
            .filter(
                models.PlanDay.user_id == user_id,
                models.PlanDay.day >= next_week_start,
                models.PlanDay.day <= next_week_start + timedelta(days=6),
            )
            .all()
        )
        if next_days:
            moved = _shift_run_from_worst_to_best(next_days, worst_day, best_day)
            if moved:
                applied_actions.append(moved)

    db.commit()

    return {
        "user_id": user_id,
        "window_weeks": window_weeks,
        "period_start": period_start,
        "period_end": period_end,
        "planned_sessions": planned_sessions,
        "completed_sessions": completed_sessions,
        "delayed_sessions": delayed_sessions,
        "long_run_misses": long_run_misses,
        "planned_km": planned_km,
        "actual_km": actual_km,
        "reliability_score": reliability_score,
        "adherence_ratio": adherence_ratio,
        "weekday_success": weekday_success,
        "suggestions": suggestions,
        "applied_actions": applied_actions,
    }
