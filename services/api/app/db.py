from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.config import settings


def _normalize_database_url(url: str) -> str:
    # Railway Postgres URLs commonly use postgresql:// which defaults to psycopg2.
    # We use psycopg (v3), so force the dialect driver explicitly.
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url[len("postgresql://") :]
    return url


engine = create_engine(_normalize_database_url(settings.DATABASE_URL))
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
