from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from app import models, schemas
from app.deps import get_db

router = APIRouter(prefix="/users", tags=["users"])


def _week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _normalize_goal_mode(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    lowered = text.lower()
    if lowered in {"prepare for an event", "event prep", "event"}:
        return "Event prep"
    if lowered in {"build up to run a distance continuously", "distance build", "distance"}:
        return "Distance build"
    return text[:30]


@router.post("/", response_model=schemas.UserOut)
def create_user(payload: schemas.UserCreate, db: Session = Depends(get_db)):
    user = models.User(**payload.model_dump())
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.get("/telegram", response_model=list[schemas.UserOut])
def get_users_with_telegram(db: Session = Depends(get_db)):
    return db.query(models.User).filter(models.User.telegram_id.isnot(None)).all()


@router.get("/by-telegram/{telegram_id}", response_model=schemas.UserOut)
def get_user_by_telegram(telegram_id: str, db: Session = Depends(get_db)):
    user = db.query(models.User).filter_by(telegram_id=telegram_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@router.get("/{user_id}", response_model=schemas.UserOut)
def get_user(user_id: int, db: Session = Depends(get_db)):
    user = db.get(models.User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@router.post("/{user_id}/profile", response_model=schemas.ProfileOut)
def upsert_profile(user_id: int, payload: schemas.ProfileCreate, db: Session = Depends(get_db)):
    user = db.get(models.User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    data = payload.model_dump()
    data["goal_mode"] = _normalize_goal_mode(data.get("goal_mode"))
    if isinstance(data.get("time_per_run"), str):
        data["time_per_run"] = str(data["time_per_run"])[:20]
    if isinstance(data.get("preferred_days"), str):
        data["preferred_days"] = str(data["preferred_days"])[:40]

    if user.profile:
        for key, value in data.items():
            setattr(user.profile, key, value)
        profile = user.profile
    else:
        profile = models.Profile(user_id=user_id, **data)
        db.add(profile)
    db.commit()
    db.refresh(profile)
    return profile


@router.post("/{user_id}/profile/bootstrap", response_model=schemas.ProfileOut)
def bootstrap_profile(user_id: int, db: Session = Depends(get_db)):
    user = db.get(models.User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    defaults = {
        "goal_mode": "Distance build",
        "goal_primary": "5K",
        "goal_date": None,
        "start_date": date.today(),
        "timeline_weeks": 12,
        "ability_level": "New",
        "weekly_availability": 3,
        "time_per_run": "Up to 45 min",
        "recent_runs_per_week": 0,
        "longest_recent_min": 0,
        "continuous_run_min": 5,
        "run_walk_ok": "Yes",
        "injury_status": "None",
        "preferred_days": "Mon/Tue/Wed/Thu/Fri/Sat/Sun",
    }

    if user.profile:
        for k, v in defaults.items():
            current = getattr(user.profile, k, None)
            if current in (None, ""):
                setattr(user.profile, k, v)
        profile = user.profile
    else:
        profile = models.Profile(user_id=user_id, **defaults)
        db.add(profile)

    db.commit()
    db.refresh(profile)
    return profile


@router.post("/{user_id}/onboarding", response_model=schemas.OnboardingOut)
def upsert_onboarding(
    user_id: int, payload: schemas.OnboardingUpdate, db: Session = Depends(get_db)
):
    user = db.get(models.User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    data = payload.model_dump(exclude_unset=True)
    if "goal_mode" in data:
        data["goal_mode"] = _normalize_goal_mode(data.get("goal_mode"))
    if isinstance(data.get("time_per_run"), str):
        data["time_per_run"] = str(data["time_per_run"])[:20]
    if isinstance(data.get("preferred_days"), str):
        data["preferred_days"] = str(data["preferred_days"])[:40]

    if user.onboarding:
        for key, value in data.items():
            setattr(user.onboarding, key, value)
        onboarding = user.onboarding
    else:
        onboarding = models.OnboardingState(user_id=user_id, **data)
        db.add(onboarding)
    db.commit()
    db.refresh(onboarding)
    return onboarding


@router.get("/{user_id}/onboarding", response_model=schemas.OnboardingOut)
def get_onboarding(user_id: int, db: Session = Depends(get_db)):
    onboarding = db.query(models.OnboardingState).filter_by(user_id=user_id).first()
    if not onboarding:
        raise HTTPException(status_code=404, detail="Onboarding not found")
    return onboarding


@router.post("/{user_id}/availability", response_model=schemas.WeeklyAvailabilityOut)
def set_weekly_availability(
    user_id: int, payload: schemas.WeeklyAvailabilityCreate, db: Session = Depends(get_db)
):
    user = db.get(models.User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    existing = (
        db.query(models.WeeklyAvailability)
        .filter_by(user_id=user_id, week_start=payload.week_start)
        .first()
    )
    if existing:
        for key, value in payload.model_dump().items():
            setattr(existing, key, value)
        availability = existing
    else:
        availability = models.WeeklyAvailability(user_id=user_id, **payload.model_dump())
        db.add(availability)
    db.commit()
    db.refresh(availability)
    return availability


@router.get("/{user_id}/availability", response_model=schemas.WeeklyAvailabilityOut)
def get_weekly_availability(
    user_id: int,
    week_start: Optional[date] = Query(None),
    db: Session = Depends(get_db),
):
    user = db.get(models.User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    target_week = week_start or _week_start(date.today())
    row = (
        db.query(models.WeeklyAvailability)
        .filter_by(user_id=user_id, week_start=target_week)
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Availability not found")
    return row
