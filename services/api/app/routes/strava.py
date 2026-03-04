from __future__ import annotations

import hmac
import time
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app import models, schemas
from app.config import settings
from app.deps import get_db, require_internal_key

router = APIRouter(prefix="/strava", tags=["strava"])

STRAVA_API = "https://www.strava.com/api/v3"
TOKEN_URL = "https://www.strava.com/oauth/token"


def _sign_state(user_id: int, ts: int) -> str:
    message = f"{user_id}:{ts}".encode()
    return hmac.new(settings.SECRET_KEY.encode(), message, sha256).hexdigest()


def _build_state(user_id: int) -> str:
    ts = int(time.time())
    sig = _sign_state(user_id, ts)
    return f"{user_id}:{ts}:{sig}"


def _parse_state(state: str) -> int:
    try:
        user_id_s, ts_s, sig = state.split(":", 2)
        user_id = int(user_id_s)
        ts = int(ts_s)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid state") from exc

    if time.time() - ts > 1800:
        raise HTTPException(status_code=400, detail="State expired")

    expected = _sign_state(user_id, ts)
    if not hmac.compare_digest(expected, sig):
        raise HTTPException(status_code=400, detail="State signature mismatch")

    return user_id


def _exchange_and_store_tokens(db: Session, user_id: int, code: str) -> None:
    user = db.get(models.User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    token_data = {
        "client_id": settings.STRAVA_CLIENT_ID,
        "client_secret": settings.STRAVA_CLIENT_SECRET,
        "code": code,
        "grant_type": "authorization_code",
    }
    with httpx.Client(timeout=15) as client:
        resp = client.post(TOKEN_URL, data=token_data)
    if resp.status_code >= 400:
        raise HTTPException(status_code=400, detail="Token exchange failed")
    tokens = resp.json()

    athlete = tokens.get("athlete", {})
    athlete_id = str(athlete.get("id", ""))
    if athlete_id:
        conflict = (
            db.query(models.StravaToken)
            .filter(models.StravaToken.athlete_id == athlete_id, models.StravaToken.user_id != user_id)
            .first()
        )
        if conflict:
            raise HTTPException(status_code=400, detail="This Strava athlete is already linked to another user")

    existing = db.query(models.StravaToken).filter_by(user_id=user_id).first()
    if existing:
        existing.access_token = tokens["access_token"]
        existing.refresh_token = tokens["refresh_token"]
        existing.expires_at = tokens["expires_at"]
        existing.athlete_id = athlete_id
        existing.athlete_name = athlete.get("firstname")
    else:
        token = models.StravaToken(
            user_id=user_id,
            access_token=tokens["access_token"],
            refresh_token=tokens["refresh_token"],
            expires_at=tokens["expires_at"],
            athlete_id=athlete_id,
            athlete_name=athlete.get("firstname"),
        )
        db.add(token)
    db.commit()


@router.get("/auth", response_model=schemas.StravaAuthOut)
def strava_auth_url(
    user_id: int = Query(..., description="User ID"),
    _auth: None = Depends(require_internal_key),
):
    if not settings.STRAVA_CLIENT_ID or not settings.STRAVA_CLIENT_SECRET:
        raise HTTPException(status_code=500, detail="Strava client not configured")

    state = _build_state(user_id)
    url = (
        "https://www.strava.com/oauth/authorize"
        f"?client_id={settings.STRAVA_CLIENT_ID}"
        f"&redirect_uri={settings.STRAVA_REDIRECT_URI}"
        "&response_type=code"
        "&approval_prompt=auto"
        "&scope=activity:read_all"
        f"&state={state}"
    )
    return {"url": url}


@router.get("/callback")
def strava_callback(
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
    db: Session = Depends(get_db),
):
    if error:
        raise HTTPException(status_code=400, detail=error)
    if not code or not state:
        raise HTTPException(status_code=400, detail="Missing code/state")

    user_id = _parse_state(state)
    _exchange_and_store_tokens(db, user_id, code)

    return {"status": "ok"}


@router.post("/exchange/{user_id}", response_model=schemas.StravaExchangeOut)
def strava_exchange(
    user_id: int,
    payload: schemas.StravaExchangeIn,
    db: Session = Depends(get_db),
    _auth: None = Depends(require_internal_key),
):
    state_user_id = _parse_state(payload.state)
    if state_user_id != user_id:
        raise HTTPException(status_code=400, detail="State/user mismatch")
    _exchange_and_store_tokens(db, user_id, payload.code)
    return {"status": "ok"}


@router.get("/status/{user_id}", response_model=schemas.StravaStatusOut)
def strava_status(
    user_id: int,
    db: Session = Depends(get_db),
    _auth: None = Depends(require_internal_key),
):
    token = db.query(models.StravaToken).filter_by(user_id=user_id).first()
    if not token:
        return {"connected": False}
    return {
        "connected": True,
        "athlete_name": token.athlete_name,
        "athlete_id": token.athlete_id,
    }


@router.post("/disconnect/{user_id}")
def strava_disconnect(
    user_id: int,
    wipe_runs: bool = Query(True),
    db: Session = Depends(get_db),
    _auth: None = Depends(require_internal_key),
):
    db.query(models.StravaToken).filter_by(user_id=user_id).delete(synchronize_session=False)
    if wipe_runs:
        db.query(models.Run).filter_by(user_id=user_id, source="strava").delete(synchronize_session=False)
    db.commit()
    return {"status": "ok", "wipe_runs": wipe_runs}


def _refresh_token(db: Session, token: models.StravaToken) -> models.StravaToken:
    if int(time.time()) < token.expires_at - 60:
        return token

    payload = {
        "client_id": settings.STRAVA_CLIENT_ID,
        "client_secret": settings.STRAVA_CLIENT_SECRET,
        "grant_type": "refresh_token",
        "refresh_token": token.refresh_token,
    }
    with httpx.Client(timeout=15) as client:
        resp = client.post(TOKEN_URL, data=payload)
    if resp.status_code >= 400:
        raise HTTPException(status_code=400, detail="Token refresh failed")
    data = resp.json()

    token.access_token = data["access_token"]
    token.refresh_token = data["refresh_token"]
    token.expires_at = data["expires_at"]
    db.commit()
    return token


def _fetch_activities(access_token: str, after_epoch: Optional[int] = None) -> list[dict[str, Any]]:
    params = {"per_page": 200, "page": 1}
    if after_epoch:
        params["after"] = after_epoch
    activities: list[dict[str, Any]] = []

    with httpx.Client(timeout=20) as client:
        while True:
            resp = client.get(
                f"{STRAVA_API}/athlete/activities",
                params=params,
                headers={"Authorization": f"Bearer {access_token}"},
            )
            if resp.status_code >= 400:
                raise HTTPException(status_code=400, detail="Strava activities fetch failed")
            batch = resp.json()
            if not batch:
                break
            activities.extend(batch)
            params["page"] += 1

    return activities


@router.post("/sync/{user_id}", response_model=schemas.StravaSyncOut)
def strava_sync(
    user_id: int,
    db: Session = Depends(get_db),
    _auth: None = Depends(require_internal_key),
):
    token = db.query(models.StravaToken).filter_by(user_id=user_id).first()
    if not token:
        raise HTTPException(status_code=404, detail="Strava not connected")

    token = _refresh_token(db, token)

    latest = (
        db.query(models.Run)
        .filter_by(user_id=user_id, source="strava")
        .order_by(models.Run.start_time.desc())
        .first()
    )
    after_epoch = None
    if latest:
        after_epoch = int(latest.start_time.replace(tzinfo=timezone.utc).timestamp())

    activities = _fetch_activities(token.access_token, after_epoch)
    existing_ids = {
        row[0]
        for row in db.query(models.Run.source_id)
        .filter_by(user_id=user_id, source="strava")
        .all()
    }

    added = 0
    for act in activities:
        act_id = str(act.get("id"))
        if not act_id or act_id in existing_ids:
            continue
        if act.get("type") not in {"Run", "TrailRun"}:
            continue
        start = datetime.fromisoformat(act["start_date"].replace("Z", "+00:00"))
        run = models.Run(
            user_id=user_id,
            source="strava",
            source_id=act_id,
            start_time=start,
            distance_m=int(act.get("distance", 0)),
            duration_s=int(act.get("moving_time", 0)),
        )
        db.add(run)
        added += 1

    if added:
        db.commit()

    return {"added": added, "total": len(activities)}
