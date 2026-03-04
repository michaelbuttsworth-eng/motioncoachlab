import os


class Settings:
    DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./dev.db")
    SECRET_KEY = os.getenv("SECRET_KEY", "dev-change-me")
    WEB_BASE_URL = os.getenv("WEB_BASE_URL", "http://localhost:5173")
    STRAVA_CLIENT_ID = os.getenv("STRAVA_CLIENT_ID", "")
    STRAVA_CLIENT_SECRET = os.getenv("STRAVA_CLIENT_SECRET", "")
    STRAVA_REDIRECT_URI = os.getenv("STRAVA_REDIRECT_URI", "http://localhost:8000/strava/callback")
    INTERNAL_API_KEY = os.getenv("MOTIONCOACH_INTERNAL_API_KEY", "")
    CORS_ALLOW_ORIGINS = os.getenv(
        "CORS_ALLOW_ORIGINS",
        "http://localhost:5173,http://localhost:8081,exp://127.0.0.1:8081",
    )


settings = Settings()
