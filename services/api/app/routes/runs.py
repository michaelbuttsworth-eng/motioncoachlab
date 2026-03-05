from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import models, schemas
from app.deps import get_db, require_internal_key

router = APIRouter(prefix="/runs", tags=["runs"])


def _ensure_run_for_user(db: Session, user_id: int, run_id: int) -> models.Run:
    run = db.get(models.Run, run_id)
    if not run or run.user_id != user_id:
        raise HTTPException(status_code=404, detail="Run not found for user")
    return run


def _apply_feedback_adaptation(db: Session, user_id: int, feedback: models.RunFeedback) -> list[str]:
    actions: list[str] = []
    notes = (feedback.notes or "").lower()
    pain_type = ""
    for part in notes.split(","):
        if "pain_type=" in part:
            pain_type = part.split("pain_type=", 1)[1].strip()
            break

    pain_red = (pain_type in {"sharp_stride_change", "stop_run_pain"}) or ("pain_form" in feedback.pain.lower())
    pain_caution = pain_type == "niggle"
    hard_flag = "max" in feedback.effort.lower() or (
        "hard" in feedback.effort.lower() and "very" in feedback.fatigue.lower()
    )
    easy_green = (
        "easy" in feedback.effort.lower()
        and "fresh" in feedback.fatigue.lower()
        and "none" in feedback.pain.lower()
    )

    if not (pain_red or pain_caution or hard_flag or easy_green):
        return actions

    start = date.today()
    end = start + timedelta(days=3 if pain_red else 2)
    rows = (
        db.query(models.PlanDay)
        .filter(
            models.PlanDay.user_id == user_id,
            models.PlanDay.day >= start,
            models.PlanDay.day <= end,
            models.PlanDay.session_type != "Rest",
        )
        .all()
    )
    if pain_red:
        for row in rows:
            old_km = int(row.planned_km or 0)
            row.session_type = "Easy Run"
            row.planned_km = max(2, int(round(old_km * 0.7)))
            row.notes = f"{(row.notes or '').strip()} Auto-adjusted after pain signal.".strip()
        if rows:
            actions.append("Pain signal detected: reduced next 72h load and switched sessions to easy effort.")
        return actions

    if pain_caution:
        for row in rows:
            old_km = int(row.planned_km or 0)
            row.session_type = "Easy Run"
            row.planned_km = max(2, int(round(old_km * 0.9)))
            row.notes = f"{(row.notes or '').strip()} Niggle detected: keep easy and monitor next run.".strip()
        if rows:
            actions.append("Niggle logged: slightly reduced next 48h load and kept sessions easy.")
        return actions

    if hard_flag:
        for row in rows:
            old_km = int(row.planned_km or 0)
            row.session_type = "Easy Run"
            row.planned_km = max(2, int(round(old_km * 0.8)))
            row.notes = f"{(row.notes or '').strip()} Auto-adjusted after hard fatigue signal.".strip()
        if rows:
            actions.append("High fatigue detected: reduced next 48h load and kept effort easy.")
        return actions

    # Green signal: only nudge one upcoming quality/easy session slightly.
    next_rows = (
        db.query(models.PlanDay)
        .filter(
            models.PlanDay.user_id == user_id,
            models.PlanDay.day >= start,
            models.PlanDay.day <= start + timedelta(days=7),
            models.PlanDay.session_type != "Rest",
        )
        .order_by(models.PlanDay.day.asc())
        .all()
    )
    if next_rows:
        row = next_rows[0]
        old_km = int(row.planned_km or 0)
        bump = max(0, min(1, int(round(old_km * 0.1))))
        if bump > 0:
            row.planned_km = old_km + bump
            row.notes = f"{(row.notes or '').strip()} Slight progression after strong check-in.".strip()
            actions.append("Strong recovery signal: added a small progression to your next run.")
    return actions


def _create_achievement(
    db: Session,
    user_id: int,
    run_id: int,
    code: str,
    title: str,
    detail: str,
) -> Optional[models.Achievement]:
    exists = (
        db.query(models.Achievement)
        .filter_by(user_id=user_id, run_id=run_id, code=code)
        .first()
    )
    if exists:
        return None
    row = models.Achievement(
        user_id=user_id,
        run_id=run_id,
        code=code,
        title=title,
        detail=detail,
    )
    db.add(row)
    return row


@router.get("/latest/{user_id}", response_model=schemas.LatestRunOut)
def latest_run(
    user_id: int,
    db: Session = Depends(get_db),
    _auth: None = Depends(require_internal_key),
):
    row = (
        db.query(models.Run)
        .filter_by(user_id=user_id)
        .order_by(models.Run.start_time.desc())
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="No runs found")
    return row


@router.post("/manual/{user_id}", response_model=schemas.LatestRunOut)
def create_manual_run(
    user_id: int,
    payload: schemas.ManualRunCreate,
    db: Session = Depends(get_db),
    _auth: None = Depends(require_internal_key),
):
    user = db.get(models.User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    duration_s = max(60, int(round(float(payload.duration_min or 0) * 60.0)))
    distance_km = float(payload.distance_km or 0.0)
    if distance_km <= 0:
        # Motion-first estimate for guided run/walk sessions.
        distance_km = max(0.5, round(float(payload.duration_min or 0) / 10.0, 2))
    now = payload.started_at or datetime.utcnow()
    source_id = f"guided-{user_id}-{int(now.timestamp())}"
    row = models.Run(
        user_id=user_id,
        source="guided",
        source_id=source_id,
        start_time=now,
        distance_m=int(round(distance_km * 1000.0)),
        duration_s=duration_s,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.get("/feedback/pending/{user_id}", response_model=schemas.LatestRunOut)
def pending_feedback_run(
    user_id: int,
    db: Session = Depends(get_db),
    _auth: None = Depends(require_internal_key),
):
    row = (
        db.query(models.Run)
        .filter_by(user_id=user_id)
        .order_by(models.Run.start_time.desc())
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="No runs found")
    done = db.query(models.RunFeedback).filter_by(user_id=user_id, run_id=row.id).first()
    if done:
        raise HTTPException(status_code=404, detail="No pending run feedback")
    return row


@router.post("/feedback/{user_id}", response_model=schemas.RunFeedbackSubmitOut)
def submit_feedback(
    user_id: int,
    payload: schemas.RunFeedbackCreate,
    db: Session = Depends(get_db),
    _auth: None = Depends(require_internal_key),
):
    _ensure_run_for_user(db, user_id, payload.run_id)
    row = db.query(models.RunFeedback).filter_by(user_id=user_id, run_id=payload.run_id).first()
    if row:
        row.effort = payload.effort
        row.fatigue = payload.fatigue
        row.pain = payload.pain
        row.session_feel = payload.session_feel
        row.notes = payload.notes
    else:
        row = models.RunFeedback(user_id=user_id, **payload.model_dump())
        db.add(row)
    db.flush()
    actions = _apply_feedback_adaptation(db, user_id, row)
    db.commit()
    db.refresh(row)
    return {"feedback": row, "actions_applied": actions}


@router.post("/achievements/check/{user_id}", response_model=schemas.AchievementCheckOut)
def check_achievements(
    user_id: int,
    run_id: Optional[int] = None,
    db: Session = Depends(get_db),
    _auth: None = Depends(require_internal_key),
):
    run = None
    if run_id is not None:
        run = _ensure_run_for_user(db, user_id, run_id)
    else:
        run = (
            db.query(models.Run)
            .filter_by(user_id=user_id)
            .order_by(models.Run.start_time.desc())
            .first()
        )
    if not run:
        raise HTTPException(status_code=404, detail="No runs found")

    created: list[models.Achievement] = []
    prior = (
        db.query(models.Run)
        .filter(models.Run.user_id == user_id, models.Run.id != run.id)
        .all()
    )
    if not prior:
        first = _create_achievement(
            db,
            user_id,
            run.id,
            "first_run",
            "First run recorded",
            "Great start. First run has been logged.",
        )
        if first:
            created.append(first)
    else:
        max_dist = max(int(r.distance_m or 0) for r in prior)
        if int(run.distance_m or 0) > max_dist:
            row = _create_achievement(
                db,
                user_id,
                run.id,
                "longest_distance",
                "New longest distance",
                f"{round((run.distance_m or 0)/1000.0,2)} km",
            )
            if row:
                created.append(row)

        max_duration = max(int(r.duration_s or 0) for r in prior)
        if int(run.duration_s or 0) > max_duration:
            row = _create_achievement(
                db,
                user_id,
                run.id,
                "longest_duration",
                "New longest duration",
                f"{round((run.duration_s or 0)/60.0,1)} minutes",
            )
            if row:
                created.append(row)

        prior_paces = [
            (r.duration_s / 60.0) / (r.distance_m / 1000.0)
            for r in prior
            if (r.distance_m or 0) >= 3000 and (r.duration_s or 0) > 0
        ]
        this_pace = None
        if (run.distance_m or 0) >= 3000 and (run.duration_s or 0) > 0:
            this_pace = (run.duration_s / 60.0) / (run.distance_m / 1000.0)
        if this_pace is not None and prior_paces and this_pace < min(prior_paces):
            row = _create_achievement(
                db,
                user_id,
                run.id,
                "fastest_pace",
                "New fastest pace",
                f"{round(this_pace,2)} min/km",
            )
            if row:
                created.append(row)

    if created:
        db.commit()
        for row in created:
            db.refresh(row)
    return {"created": created}


@router.get("/achievements/{user_id}", response_model=list[schemas.AchievementOut])
def list_achievements(
    user_id: int,
    db: Session = Depends(get_db),
    _auth: None = Depends(require_internal_key),
):
    return (
        db.query(models.Achievement)
        .filter_by(user_id=user_id)
        .order_by(models.Achievement.created_at.desc())
        .limit(100)
        .all()
    )


@router.post("/pilot-feedback/{user_id}", response_model=schemas.PilotFeedbackOut)
def create_pilot_feedback(
    user_id: int,
    payload: schemas.PilotFeedbackCreate,
    db: Session = Depends(get_db),
    _auth: None = Depends(require_internal_key),
):
    user = db.get(models.User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    row = models.PilotFeedback(user_id=user_id, **payload.model_dump())
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.get("/pilot-feedback/{user_id}", response_model=list[schemas.PilotFeedbackOut])
def list_pilot_feedback(
    user_id: int,
    limit: int = 100,
    db: Session = Depends(get_db),
    _auth: None = Depends(require_internal_key),
):
    return (
        db.query(models.PilotFeedback)
        .filter_by(user_id=user_id)
        .order_by(models.PilotFeedback.created_at.desc())
        .limit(max(1, min(limit, 500)))
        .all()
    )
