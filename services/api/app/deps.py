import hmac
from typing import Generator
from fastapi import Header, HTTPException
from app.db import SessionLocal
from app.config import settings


def get_db() -> Generator:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def require_internal_key(x_internal_key: str = Header(default="")) -> None:
    expected = settings.INTERNAL_API_KEY
    if not expected:
        raise HTTPException(status_code=500, detail="Internal API key not configured")
    if not hmac.compare_digest(x_internal_key, expected):
        raise HTTPException(status_code=403, detail="Forbidden")
