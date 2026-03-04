from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app import models
from app.db import engine
from app.routes import users, strava, plans, runs, mobile, auth
from sqlalchemy import text
from app.config import settings

app = FastAPI(title="MotionCoachLab API", version="0.1.0")
origins = [o.strip() for o in settings.CORS_ALLOW_ORIGINS.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _run_lightweight_migrations() -> None:
    if engine.dialect.name != "sqlite":
        return
    with engine.begin() as conn:
        onboarding_cols = conn.execute(text("PRAGMA table_info(onboarding_state)")).fetchall()
        onboarding_names = {c[1] for c in onboarding_cols}
        if "engagement_mode" not in onboarding_names:
            conn.execute(text("ALTER TABLE onboarding_state ADD COLUMN engagement_mode VARCHAR(20)"))
        if "goal_mode" not in onboarding_names:
            conn.execute(text("ALTER TABLE onboarding_state ADD COLUMN goal_mode VARCHAR(30)"))
        if "goal_date" not in onboarding_names:
            conn.execute(text("ALTER TABLE onboarding_state ADD COLUMN goal_date DATE"))
        if "recent_runs_per_week" not in onboarding_names:
            conn.execute(text("ALTER TABLE onboarding_state ADD COLUMN recent_runs_per_week INTEGER"))
        if "longest_recent_min" not in onboarding_names:
            conn.execute(text("ALTER TABLE onboarding_state ADD COLUMN longest_recent_min INTEGER"))
        if "continuous_run_min" not in onboarding_names:
            conn.execute(text("ALTER TABLE onboarding_state ADD COLUMN continuous_run_min INTEGER"))
        if "run_walk_ok" not in onboarding_names:
            conn.execute(text("ALTER TABLE onboarding_state ADD COLUMN run_walk_ok VARCHAR(10)"))
        if "start_date" not in onboarding_names:
            conn.execute(text("ALTER TABLE onboarding_state ADD COLUMN start_date DATE"))

        profile_cols = conn.execute(text("PRAGMA table_info(profiles)")).fetchall()
        profile_names = {c[1] for c in profile_cols}
        if "goal_mode" not in profile_names:
            conn.execute(text("ALTER TABLE profiles ADD COLUMN goal_mode VARCHAR(30)"))
        if "goal_date" not in profile_names:
            conn.execute(text("ALTER TABLE profiles ADD COLUMN goal_date DATE"))
        if "recent_runs_per_week" not in profile_names:
            conn.execute(text("ALTER TABLE profiles ADD COLUMN recent_runs_per_week INTEGER"))
        if "longest_recent_min" not in profile_names:
            conn.execute(text("ALTER TABLE profiles ADD COLUMN longest_recent_min INTEGER"))
        if "continuous_run_min" not in profile_names:
            conn.execute(text("ALTER TABLE profiles ADD COLUMN continuous_run_min INTEGER"))
        if "run_walk_ok" not in profile_names:
            conn.execute(text("ALTER TABLE profiles ADD COLUMN run_walk_ok VARCHAR(10)"))
        if "start_date" not in profile_names:
            conn.execute(text("ALTER TABLE profiles ADD COLUMN start_date DATE"))


@app.on_event("startup")
def on_startup() -> None:
    models.Base.metadata.create_all(bind=engine)
    _run_lightweight_migrations()


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


app.include_router(users.router)
app.include_router(strava.router)
app.include_router(plans.router)
app.include_router(runs.router)
app.include_router(mobile.router)
app.include_router(auth.router)
