from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.config import settings
from urllib.parse import urlsplit, urlunsplit


def _normalize_database_url(url: str) -> str:
    # Railway/CI UIs sometimes inject whitespace/quotes when copy-pasting values.
    cleaned = (url or "").strip().strip('"').strip("'").replace("\r", "").replace("\n", "")

    # Catch unresolved placeholder-style values early with an explicit error.
    if "<" in cleaned and ">" in cleaned:
        raise ValueError("DATABASE_URL contains placeholder text. Paste a full Postgres URL.")

    # Railway Postgres URLs commonly use postgresql:// which defaults to psycopg2.
    # We use psycopg (v3), so force the dialect driver explicitly.
    if cleaned.startswith("postgresql://"):
        cleaned = "postgresql+psycopg://" + cleaned[len("postgresql://") :]

    # Remove accidental quote/whitespace in db name/path from malformed env input.
    parts = urlsplit(cleaned)
    path = (parts.path or "").strip().strip('"').strip("'")
    cleaned = urlunsplit((parts.scheme, parts.netloc, path, parts.query, parts.fragment))
    return cleaned


engine = create_engine(_normalize_database_url(settings.DATABASE_URL))
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
