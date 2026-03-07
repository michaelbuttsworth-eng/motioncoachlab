from __future__ import annotations

import hashlib
import hmac
import json
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.orm import Session

from app import models, schemas
from app.config import settings
from app.deps import get_db
from app.routes.runs import _apply_feedback_adaptation

router = APIRouter(prefix="/mobile", tags=["mobile"])


def _week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())

def _client_today(client_date: Optional[str]) -> date:
    if client_date:
        try:
            return date.fromisoformat(client_date)
        except Exception:
            pass
    return date.today()


def _match_planned_sessions_to_runs(
    planned_run_days: list[date],
    run_dates: list[date],
    grace_days: int = 2,
) -> tuple[int, int, int]:
    # completed = same-day + delayed(within grace)
    # delayed = matched but after planned day
    # on_time = matched on the same day
    used = [False] * len(run_dates)
    completed = 0
    delayed = 0
    on_time = 0
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
        else:
            on_time += 1
    return completed, delayed, on_time


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _resolve_auth_user_id(db: Session, authorization: str) -> Optional[int]:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        return None
    session = db.query(models.AuthSession).filter_by(token_hash=_hash_token(token)).first()
    if not session or session.revoked_at is not None or session.expires_at <= datetime.utcnow():
        return None
    session.last_seen_at = datetime.utcnow()
    db.commit()
    return int(session.user_id)


def _authorize_user_scope(
    db: Session,
    requested_user_id: int,
    authorization: str,
    x_internal_key: str,
) -> None:
    expected = settings.INTERNAL_API_KEY
    if expected and x_internal_key and hmac.compare_digest(x_internal_key, expected):
        return
    auth_user_id = _resolve_auth_user_id(db, authorization)
    if auth_user_id is None:
        raise HTTPException(status_code=401, detail="Unauthorized")
    if int(auth_user_id) != int(requested_user_id):
        raise HTTPException(status_code=403, detail="Forbidden")


def _parse_c25k(notes: Optional[str]) -> Optional[dict]:
    if not notes or not str(notes).startswith("C25K|"):
        return None
    out: dict = {}
    for part in str(notes).split("|")[1:]:
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        try:
            out[k] = float(v)
        except Exception:
            out[k] = v
    return out


@router.post("/session/start", response_model=schemas.MobileSessionOut)
def mobile_session_start(
    payload: schemas.MobileSessionStartIn,
    authorization: str = Header(default=""),
    x_internal_key: str = Header(default=""),
    db: Session = Depends(get_db),
):
    _authorize_user_scope(db, payload.user_id, authorization, x_internal_key)
    user = db.get(models.User, payload.user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    session = models.DeviceSession(
        user_id=payload.user_id,
        status="started",
        started_at=payload.started_at or datetime.utcnow(),
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


@router.post("/session/{session_id}/event")
def mobile_session_event(
    session_id: int,
    payload: schemas.MobileSessionEventIn,
    authorization: str = Header(default=""),
    x_internal_key: str = Header(default=""),
    db: Session = Depends(get_db),
):
    session = db.get(models.DeviceSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _authorize_user_scope(db, int(session.user_id), authorization, x_internal_key)

    evt = models.DeviceSessionEvent(
        session_id=session_id,
        event_type=payload.event_type,
        ts=payload.ts or datetime.utcnow(),
        payload_json=payload.payload_json,
    )
    db.add(evt)
    db.commit()
    return {"status": "ok"}


@router.post("/session/{session_id}/stop", response_model=schemas.MobileSessionOut)
def mobile_session_stop(
    session_id: int,
    payload: schemas.MobileSessionStopIn,
    authorization: str = Header(default=""),
    x_internal_key: str = Header(default=""),
    db: Session = Depends(get_db),
):
    session = db.get(models.DeviceSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    _authorize_user_scope(db, int(session.user_id), authorization, x_internal_key)

    ended_at = payload.ended_at or datetime.utcnow()
    duration_s = max(1, int(payload.duration_s or 0))
    distance_m = max(0, int(payload.distance_m or 0))
    avg_pace = None
    if distance_m > 0:
        avg_pace = round((duration_s / 60.0) / (distance_m / 1000.0), 2)

    session.status = "completed"
    session.ended_at = ended_at
    session.duration_s = duration_s
    session.distance_m = distance_m
    session.route_polyline = payload.route_polyline
    session.avg_pace_min_km = avg_pace

    run = models.Run(
        user_id=session.user_id,
        source="mobile_gps",
        source_id=f"mobile-{session_id}",
        start_time=session.started_at,
        distance_m=distance_m,
        duration_s=duration_s,
    )
    db.add(run)
    db.flush()
    session.run_id = run.id

    db.commit()
    db.refresh(session)
    return session


@router.post("/session/{session_id}/checkin", response_model=schemas.RunFeedbackSubmitOut)
def mobile_session_checkin(
    session_id: int,
    payload: schemas.MobileSessionCheckinIn,
    authorization: str = Header(default=""),
    x_internal_key: str = Header(default=""),
    db: Session = Depends(get_db),
):
    session = db.get(models.DeviceSession, session_id)
    if not session or not session.run_id:
        raise HTTPException(status_code=404, detail="Completed session with run not found")
    _authorize_user_scope(db, int(session.user_id), authorization, x_internal_key)

    row = (
        db.query(models.RunFeedback)
        .filter_by(user_id=session.user_id, run_id=session.run_id)
        .first()
    )
    if row:
        row.effort = payload.effort
        row.fatigue = payload.fatigue
        row.pain = payload.pain
        row.session_feel = payload.session_feel
        row.notes = payload.notes
    else:
        row = models.RunFeedback(
            user_id=session.user_id,
            run_id=session.run_id,
            effort=payload.effort,
            fatigue=payload.fatigue,
            pain=payload.pain,
            session_feel=payload.session_feel,
            notes=payload.notes,
        )
        db.add(row)

    db.flush()
    # Keep collecting check-in data, but do not auto-adjust the training plan yet.
    actions: list[str] = []
    db.commit()
    db.refresh(row)
    return {"feedback": row, "actions_applied": actions}


@router.get("/plan/today/{user_id}", response_model=schemas.MobilePlanTodayOut)
def mobile_plan_today(
    user_id: int,
    client_date: Optional[str] = None,
    authorization: str = Header(default=""),
    x_internal_key: str = Header(default=""),
    db: Session = Depends(get_db),
):
    _authorize_user_scope(db, user_id, authorization, x_internal_key)
    today = _client_today(client_date)
    row = db.query(models.PlanDay).filter_by(user_id=user_id, day=today).first()
    if not row:
        raise HTTPException(status_code=404, detail="No plan for today")

    interval = _parse_c25k(row.notes)
    planned_km = float(row.planned_km or 0)
    session_type = str(row.session_type or "Run/Walk")
    return {
        "user_id": user_id,
        "day": row.day,
        "session_type": session_type,
        "planned_km": planned_km,
        "notes": row.notes,
        "interval": interval,
    }


@router.get("/plan/upcoming/{user_id}", response_model=schemas.MobilePlanUpcomingOut)
def mobile_plan_upcoming(
    user_id: int,
    limit: int = 5,
    include_rest: bool = False,
    client_date: Optional[str] = None,
    authorization: str = Header(default=""),
    x_internal_key: str = Header(default=""),
    db: Session = Depends(get_db),
):
    _authorize_user_scope(db, user_id, authorization, x_internal_key)
    today = _client_today(client_date)
    capped_limit = max(1, min(int(limit or 5), 14))
    query = db.query(models.PlanDay).filter(
        models.PlanDay.user_id == user_id,
        models.PlanDay.day >= today,
    )
    if not include_rest:
        query = query.filter(models.PlanDay.session_type != "Rest")
    rows = query.order_by(models.PlanDay.day.asc()).limit(capped_limit).all()

    items: list[dict] = []
    for row in rows:
        interval = _parse_c25k(row.notes)
        total_motion_min = None
        if interval:
            try:
                total_motion_min = int(
                    round(
                        float(interval.get("warmup", 0))
                        + float(interval.get("cooldown", 0))
                        + (float(interval.get("run", 0)) + float(interval.get("walk", 0)))
                        * float(interval.get("repeats", 0))
                    )
                )
            except Exception:
                total_motion_min = None
        items.append(
            {
                "day": row.day,
                "session_type": str(row.session_type or "Run/Walk"),
                "planned_km": float(row.planned_km or 0),
                "notes": row.notes,
                "interval": interval,
                "total_motion_min": total_motion_min,
            }
        )
    return {"user_id": user_id, "items": items}


@router.get("/progress/{user_id}", response_model=schemas.MobileProgressOut)
def mobile_progress(
    user_id: int,
    client_date: Optional[str] = None,
    authorization: str = Header(default=""),
    x_internal_key: str = Header(default=""),
    db: Session = Depends(get_db),
):
    _authorize_user_scope(db, user_id, authorization, x_internal_key)
    today = _client_today(client_date)
    wk = _week_start(today)

    runs = db.query(models.Run).filter_by(user_id=user_id).all()
    total_km = round(sum((r.distance_m or 0) for r in runs) / 1000.0, 2)

    week_runs = []
    for r in runs:
        d = r.start_time.date()
        if wk <= d <= today:
            week_runs.append(r)
    week_distance_km = round(sum((r.distance_m or 0) for r in week_runs) / 1000.0, 2)
    week_motion_min = round(sum((r.duration_s or 0) for r in week_runs) / 60.0, 1)

    # Entire plan completion: planned sessions across all generated plan days.
    planned_days_all = (
        db.query(models.PlanDay)
        .filter(
            models.PlanDay.user_id == user_id,
        )
        .all()
    )
    planned_run_days_all = [
        d.day
        for d in planned_days_all
        if str(d.session_type or "").lower() != "rest"
    ]
    run_dates_all = sorted([r.start_time.date() for r in runs])
    planned_total_runs = len(planned_run_days_all)
    completed_planned_runs, delayed_total_runs, on_time_total_runs = _match_planned_sessions_to_runs(
        planned_run_days_all, run_dates_all
    )

    # Current week completion (to today) for the week summary line.
    planned_week_days = [
        d.day for d in planned_days_all if wk <= d.day <= today and str(d.session_type or "").lower() != "rest"
    ]
    run_dates_week = sorted([r.start_time.date() for r in runs if wk <= r.start_time.date() <= today])
    planned_week_runs = len(planned_week_days)
    completed_week_runs, _, _ = _match_planned_sessions_to_runs(planned_week_days, run_dates_week)

    plan_adherence_pct = (
        round((completed_planned_runs / planned_total_runs) * 100.0, 1) if planned_total_runs else 0.0
    )
    on_time_completion_pct = (
        round((on_time_total_runs / planned_total_runs) * 100.0, 1) if planned_total_runs else 0.0
    )
    delay_rate = (delayed_total_runs / planned_total_runs) if planned_total_runs else 0.0
    consistency_score = round(max(0.0, (0.7 * (plan_adherence_pct / 100.0)) + (0.3 * (1.0 - delay_rate))) * 100, 1)

    load_by_week: dict[date, float] = {}
    for r in runs:
        d = r.start_time.date()
        if d < (today - timedelta(days=27)) or d > today:
            continue
        ws = _week_start(d)
        distance_km = float(r.distance_m or 0) / 1000.0
        duration_min = float(r.duration_s or 0) / 60.0
        load = distance_km + (duration_min / 10.0)
        load_by_week[ws] = load_by_week.get(ws, 0.0) + load

    current_load = round(load_by_week.get(wk, 0.0), 2)
    prior_load = round(load_by_week.get(wk - timedelta(days=7), 0.0), 2)
    if prior_load <= 0:
        trend_pct = 0.0 if current_load <= 0 else 100.0
    else:
        trend_pct = round(((current_load - prior_load) / prior_load) * 100.0, 1)
    if trend_pct >= 7:
        trend_label = "building"
    elif trend_pct <= -7:
        trend_label = "recovering"
    else:
        trend_label = "stable"

    return {
        "user_id": user_id,
        "week_start": wk,
        "week_motion_min": week_motion_min,
        "week_distance_km": week_distance_km,
        "total_distance_km": total_km,
        "planned_total_runs": planned_total_runs,
        "completed_planned_runs": completed_planned_runs,
        "planned_week_runs": planned_week_runs,
        "completed_week_runs": completed_week_runs,
        "plan_adherence_pct": plan_adherence_pct,
        "on_time_completion_pct": on_time_completion_pct,
        "consistency_score": consistency_score,
        "training_load_trend_pct": trend_pct,
        "training_load_trend_label": trend_label,
    }


@router.get("/history/{user_id}", response_model=schemas.MobileHistoryOut)
def mobile_history(
    user_id: int,
    limit: int = 30,
    authorization: str = Header(default=""),
    x_internal_key: str = Header(default=""),
    db: Session = Depends(get_db),
):
    _authorize_user_scope(db, user_id, authorization, x_internal_key)
    rows = (
        db.query(models.Run)
        .filter_by(user_id=user_id)
        .order_by(models.Run.start_time.desc())
        .limit(max(1, min(limit, 200)))
        .all()
    )
    if not rows:
        return {"user_id": user_id, "items": []}

    run_ids = [r.id for r in rows]
    feedback_by_run: dict[int, models.RunFeedback] = {}
    for fb in db.query(models.RunFeedback).filter(models.RunFeedback.run_id.in_(run_ids)).all():
        feedback_by_run[fb.run_id] = fb

    device_by_run: dict[int, models.DeviceSession] = {}
    for ds in db.query(models.DeviceSession).filter(models.DeviceSession.run_id.in_(run_ids)).all():
        if ds.run_id is not None:
            device_by_run[ds.run_id] = ds

    items = []
    for r in rows:
        pace = None
        if (r.distance_m or 0) > 0:
            pace = round((r.duration_s / 60.0) / (r.distance_m / 1000.0), 2)
        fb = feedback_by_run.get(r.id)
        ds = device_by_run.get(r.id)
        items.append(
            {
                "run_id": r.id,
                "started_at": r.start_time,
                "source": r.source,
                "distance_m": int(r.distance_m or 0),
                "duration_s": int(r.duration_s or 0),
                "pace_min_km": pace,
                "route_polyline": ds.route_polyline if ds else None,
                "effort": fb.effort if fb else None,
                "fatigue": fb.fatigue if fb else None,
                "pain": fb.pain if fb else None,
                "session_feel": fb.session_feel if fb else None,
            }
        )
    return {"user_id": user_id, "items": items}


def _delete_run_and_related(db: Session, user_id: int, run_id: int) -> None:
    run = db.get(models.Run, run_id)
    if not run or int(run.user_id) != int(user_id):
        raise HTTPException(status_code=404, detail="Run not found")

    session_ids = [int(s.id) for s in db.query(models.DeviceSession.id).filter(models.DeviceSession.run_id == run_id).all()]

    if session_ids:
        db.query(models.DeviceSessionEvent).filter(models.DeviceSessionEvent.session_id.in_(session_ids)).delete(
            synchronize_session=False
        )
    db.query(models.RunFeedback).filter(models.RunFeedback.run_id == run_id).delete(synchronize_session=False)
    db.query(models.Achievement).filter(models.Achievement.run_id == run_id).delete(synchronize_session=False)
    db.query(models.CommunityContribution).filter(models.CommunityContribution.run_id == run_id).delete(
        synchronize_session=False
    )
    db.query(models.DeviceSession).filter(models.DeviceSession.run_id == run_id).delete(synchronize_session=False)
    db.query(models.Run).filter(models.Run.id == run_id, models.Run.user_id == user_id).delete(synchronize_session=False)
    db.commit()


@router.delete("/history/{user_id}/{run_id}", response_model=schemas.MobileRunDeleteOut)
def mobile_history_delete_run(
    user_id: int,
    run_id: int,
    authorization: str = Header(default=""),
    x_internal_key: str = Header(default=""),
    db: Session = Depends(get_db),
):
    _authorize_user_scope(db, user_id, authorization, x_internal_key)
    _delete_run_and_related(db, user_id, run_id)
    return {"run_id": run_id, "deleted": True}


@router.post("/history/{user_id}/{run_id}/delete", response_model=schemas.MobileRunDeleteOut)
def mobile_history_delete_run_post(
    user_id: int,
    run_id: int,
    authorization: str = Header(default=""),
    x_internal_key: str = Header(default=""),
    db: Session = Depends(get_db),
):
    _authorize_user_scope(db, user_id, authorization, x_internal_key)
    _delete_run_and_related(db, user_id, run_id)
    return {"run_id": run_id, "deleted": True}


@router.post("/history/{user_id}/{run_id}", response_model=schemas.MobileRunDeleteOut)
def mobile_history_delete_run_post_alt(
    user_id: int,
    run_id: int,
    authorization: str = Header(default=""),
    x_internal_key: str = Header(default=""),
    db: Session = Depends(get_db),
):
    # Compatibility alias used by older clients.
    _authorize_user_scope(db, user_id, authorization, x_internal_key)
    _delete_run_and_related(db, user_id, run_id)
    return {"run_id": run_id, "deleted": True}


@router.get("/pilot-report/{user_id}", response_model=schemas.PilotReportOut)
def mobile_pilot_report(
    user_id: int,
    days: int = 14,
    authorization: str = Header(default=""),
    x_internal_key: str = Header(default=""),
    db: Session = Depends(get_db),
):
    _authorize_user_scope(db, user_id, authorization, x_internal_key)
    today = date.today()
    days = max(1, min(days, 90))
    start_d = today - timedelta(days=days - 1)
    start_dt = datetime.combine(start_d, datetime.min.time())

    sessions = (
        db.query(models.DeviceSession)
        .filter(models.DeviceSession.user_id == user_id, models.DeviceSession.started_at >= start_dt)
        .all()
    )
    started = len(sessions)
    completed = sum(1 for s in sessions if str(s.status or "").lower() == "completed")
    session_ids = [s.id for s in sessions]

    checkins = 0
    total_m = 0
    total_s = 0
    run_ids = [int(s.run_id) for s in sessions if s.run_id]
    if run_ids:
        runs = db.query(models.Run).filter(models.Run.id.in_(run_ids)).all()
        total_m = sum(int(r.distance_m or 0) for r in runs)
        total_s = sum(int(r.duration_s or 0) for r in runs)
        checkins = (
            db.query(models.RunFeedback)
            .filter(models.RunFeedback.user_id == user_id, models.RunFeedback.run_id.in_(run_ids))
            .count()
        )
    return {
        "user_id": user_id,
        "days": days,
        "period_start": start_d,
        "period_end": today,
        "sessions_started": started,
        "sessions_completed": completed,
        "checkins_submitted": checkins,
        "total_distance_km": round(total_m / 1000.0, 2),
        "total_motion_min": round(total_s / 60.0, 1),
    }
