from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy.orm import Session

from app import models, schemas
from app.deps import get_db

router = APIRouter(prefix="/auth", tags=["auth"])


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.utcnow()


def _user_from_bearer(db: Session, authorization: str) -> models.User:
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token_hash = _hash_token(token)
    session = (
        db.query(models.AuthSession)
        .filter_by(token_hash=token_hash)
        .first()
    )
    if not session or session.revoked_at is not None or session.expires_at <= _now():
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    session.last_seen_at = _now()
    user = db.get(models.User, session.user_id)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid token user")
    db.commit()
    return user


@router.post("/guest", response_model=schemas.AuthGuestOut)
def auth_guest(payload: schemas.AuthGuestIn, db: Session = Depends(get_db)):
    user: Optional[models.User] = None
    if payload.device_id:
        ident = (
            db.query(models.AuthIdentity)
            .filter_by(provider="guest_device", provider_user_id=payload.device_id)
            .first()
        )
        if ident:
            user = db.get(models.User, ident.user_id)

    if not user:
        name = (payload.name or "Runner").strip()[:120] or "Runner"
        user = models.User(name=name, email=None, telegram_id=None)
        db.add(user)
        db.flush()
        if payload.device_id:
            db.add(
                models.AuthIdentity(
                    user_id=user.id,
                    provider="guest_device",
                    provider_user_id=payload.device_id,
                    email=None,
                )
            )

    raw_token = secrets.token_urlsafe(32)
    row = models.AuthSession(
        user_id=user.id,
        token_hash=_hash_token(raw_token),
        device_id=payload.device_id,
        expires_at=_now() + timedelta(days=180),
    )
    db.add(row)
    db.commit()
    return {
        "token": raw_token,
        "user_id": user.id,
        "name": user.name,
        "expires_at": row.expires_at,
    }


@router.get("/me", response_model=schemas.AuthMeOut)
def auth_me(
    authorization: str = Header(default=""),
    db: Session = Depends(get_db),
):
    user = _user_from_bearer(db, authorization)
    return {"user_id": user.id, "name": user.name, "email": user.email}


@router.post("/link/{provider}")
def auth_link_provider(
    provider: str,
    payload: schemas.AuthLinkIn,
    authorization: str = Header(default=""),
    db: Session = Depends(get_db),
):
    _ = _user_from_bearer(db, authorization)
    p = provider.lower().strip()
    if p not in {"apple", "google", "facebook"}:
        raise HTTPException(status_code=400, detail="Unsupported provider")
    # Placeholder for future provider token/code exchange + verification.
    return {
        "status": "not_implemented",
        "provider": p,
        "message": "Provider login/link is planned next. Guest auth is active now.",
    }
