from __future__ import annotations

from datetime import date, datetime
from typing import Optional
from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    name: Mapped[str] = mapped_column(String(120))
    email: Mapped[Optional[str]] = mapped_column(String(255), unique=True)
    telegram_id: Mapped[Optional[str]] = mapped_column(String(64), unique=True)

    profile = relationship("Profile", back_populates="user", uselist=False)
    strava = relationship("StravaToken", back_populates="user", uselist=False)
    onboarding = relationship("OnboardingState", back_populates="user", uselist=False)


class Profile(Base):
    __tablename__ = "profiles"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), unique=True)
    goal_mode: Mapped[Optional[str]] = mapped_column(String(30))
    goal_primary: Mapped[str] = mapped_column(String(40))
    goal_date: Mapped[Optional[date]] = mapped_column(Date)
    start_date: Mapped[Optional[date]] = mapped_column(Date)
    timeline_weeks: Mapped[Optional[int]] = mapped_column(Integer)
    ability_level: Mapped[str] = mapped_column(String(30))
    weekly_availability: Mapped[int] = mapped_column(Integer)
    time_per_run: Mapped[str] = mapped_column(String(20))
    recent_runs_per_week: Mapped[Optional[int]] = mapped_column(Integer)
    longest_recent_min: Mapped[Optional[int]] = mapped_column(Integer)
    continuous_run_min: Mapped[Optional[int]] = mapped_column(Integer)
    run_walk_ok: Mapped[Optional[str]] = mapped_column(String(10))
    injury_status: Mapped[str] = mapped_column(String(30))
    preferred_days: Mapped[str] = mapped_column(String(40))

    user = relationship("User", back_populates="profile")


class OnboardingState(Base):
    __tablename__ = "onboarding_state"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), unique=True)
    current_step: Mapped[int] = mapped_column(Integer, default=1)
    goal_mode: Mapped[Optional[str]] = mapped_column(String(30))
    goal_primary: Mapped[Optional[str]] = mapped_column(String(40))
    goal_date: Mapped[Optional[date]] = mapped_column(Date)
    start_date: Mapped[Optional[date]] = mapped_column(Date)
    timeline_weeks: Mapped[Optional[int]] = mapped_column(Integer)
    ability_level: Mapped[Optional[str]] = mapped_column(String(30))
    weekly_availability: Mapped[Optional[int]] = mapped_column(Integer)
    time_per_run: Mapped[Optional[str]] = mapped_column(String(20))
    recent_runs_per_week: Mapped[Optional[int]] = mapped_column(Integer)
    longest_recent_min: Mapped[Optional[int]] = mapped_column(Integer)
    continuous_run_min: Mapped[Optional[int]] = mapped_column(Integer)
    run_walk_ok: Mapped[Optional[str]] = mapped_column(String(10))
    injury_status: Mapped[Optional[str]] = mapped_column(String(30))
    preferred_days: Mapped[Optional[str]] = mapped_column(String(40))
    engagement_mode: Mapped[Optional[str]] = mapped_column(String(20))
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="onboarding")


class StravaToken(Base):
    __tablename__ = "strava_tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), unique=True)
    athlete_id: Mapped[str] = mapped_column(String(64))
    athlete_name: Mapped[Optional[str]] = mapped_column(String(120))
    access_token: Mapped[str] = mapped_column(String(255))
    refresh_token: Mapped[str] = mapped_column(String(255))
    expires_at: Mapped[int] = mapped_column(Integer)

    user = relationship("User", back_populates="strava")


class WeeklyAvailability(Base):
    __tablename__ = "weekly_availability"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    week_start: Mapped[date] = mapped_column(Date)
    mon: Mapped[bool] = mapped_column(Boolean, default=True)
    tue: Mapped[bool] = mapped_column(Boolean, default=True)
    wed: Mapped[bool] = mapped_column(Boolean, default=True)
    thu: Mapped[bool] = mapped_column(Boolean, default=True)
    fri: Mapped[bool] = mapped_column(Boolean, default=True)
    sat: Mapped[bool] = mapped_column(Boolean, default=True)
    sun: Mapped[bool] = mapped_column(Boolean, default=True)

    __table_args__ = (UniqueConstraint("user_id", "week_start"),)


class PlanWeek(Base):
    __tablename__ = "plan_weeks"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    week_start: Mapped[date] = mapped_column(Date)
    focus: Mapped[str] = mapped_column(String(80))
    target_km: Mapped[int] = mapped_column(Integer)

    __table_args__ = (UniqueConstraint("user_id", "week_start"),)


class PlanDay(Base):
    __tablename__ = "plan_days"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    day: Mapped[date] = mapped_column(Date)
    session_type: Mapped[str] = mapped_column(String(40))
    planned_km: Mapped[int] = mapped_column(Integer)
    notes: Mapped[Optional[str]] = mapped_column(Text)

    __table_args__ = (UniqueConstraint("user_id", "day"),)


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    source: Mapped[str] = mapped_column(String(20), default="strava")
    source_id: Mapped[str] = mapped_column(String(64))
    start_time: Mapped[datetime] = mapped_column(DateTime)
    distance_m: Mapped[int] = mapped_column(Integer)
    duration_s: Mapped[int] = mapped_column(Integer)

    __table_args__ = (UniqueConstraint("source", "source_id"),)


class RunFeedback(Base):
    __tablename__ = "run_feedback"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id"))
    submitted_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    effort: Mapped[str] = mapped_column(String(20))
    fatigue: Mapped[str] = mapped_column(String(20))
    pain: Mapped[str] = mapped_column(String(30))
    session_feel: Mapped[str] = mapped_column(String(20))
    notes: Mapped[Optional[str]] = mapped_column(Text)

    __table_args__ = (UniqueConstraint("user_id", "run_id"),)


class Achievement(Base):
    __tablename__ = "achievements"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    run_id: Mapped[Optional[int]] = mapped_column(ForeignKey("runs.id"))
    code: Mapped[str] = mapped_column(String(40))
    title: Mapped[str] = mapped_column(String(120))
    detail: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (UniqueConstraint("user_id", "run_id", "code"),)


class PilotFeedback(Base):
    __tablename__ = "pilot_feedback"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    source: Mapped[str] = mapped_column(String(30), default="chat")
    category: Mapped[str] = mapped_column(String(30), default="general")
    text: Mapped[str] = mapped_column(Text)


class CommunityGoal(Base):
    __tablename__ = "community_goals"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date] = mapped_column(Date)
    target_km: Mapped[int] = mapped_column(Integer)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class CommunityContribution(Base):
    __tablename__ = "community_contributions"

    id: Mapped[int] = mapped_column(primary_key=True)
    goal_id: Mapped[int] = mapped_column(ForeignKey("community_goals.id"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    run_id: Mapped[Optional[int]] = mapped_column(ForeignKey("runs.id"))
    distance_m: Mapped[int] = mapped_column(Integer)
    contributed_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (UniqueConstraint("goal_id", "user_id", "run_id"),)


class UserBehaviorMetric(Base):
    __tablename__ = "user_behavior_metrics"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    computed_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    window_weeks: Mapped[int] = mapped_column(Integer, default=6)
    period_start: Mapped[date] = mapped_column(Date)
    period_end: Mapped[date] = mapped_column(Date)
    planned_sessions: Mapped[int] = mapped_column(Integer, default=0)
    completed_sessions: Mapped[int] = mapped_column(Integer, default=0)
    planned_km: Mapped[float] = mapped_column(Float, default=0)
    actual_km: Mapped[float] = mapped_column(Float, default=0)
    reliability_score: Mapped[float] = mapped_column(Float, default=0)
    adherence_ratio: Mapped[float] = mapped_column(Float, default=0)
    delayed_sessions: Mapped[int] = mapped_column(Integer, default=0)
    long_run_misses: Mapped[int] = mapped_column(Integer, default=0)
    weekday_success_json: Mapped[str] = mapped_column(Text, default="{}")


class UserBehaviorSuggestion(Base):
    __tablename__ = "user_behavior_suggestions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    period_start: Mapped[date] = mapped_column(Date)
    period_end: Mapped[date] = mapped_column(Date)
    code: Mapped[str] = mapped_column(String(64))
    title: Mapped[str] = mapped_column(String(120))
    reason: Mapped[str] = mapped_column(Text)
    action: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="proposed")


class DeviceSession(Base):
    __tablename__ = "device_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(20), default="started")
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    ended_at: Mapped[Optional[datetime]] = mapped_column(DateTime)
    duration_s: Mapped[Optional[int]] = mapped_column(Integer)
    distance_m: Mapped[Optional[int]] = mapped_column(Integer)
    source: Mapped[str] = mapped_column(String(20), default="mobile_gps")
    route_polyline: Mapped[Optional[str]] = mapped_column(Text)
    avg_pace_min_km: Mapped[Optional[float]] = mapped_column(Float)
    run_id: Mapped[Optional[int]] = mapped_column(ForeignKey("runs.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class DeviceSessionEvent(Base):
    __tablename__ = "device_session_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("device_sessions.id"))
    event_type: Mapped[str] = mapped_column(String(40))
    ts: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    payload_json: Mapped[Optional[str]] = mapped_column(Text)


class AuthIdentity(Base):
    __tablename__ = "auth_identities"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    provider: Mapped[str] = mapped_column(String(30))
    provider_user_id: Mapped[str] = mapped_column(String(255))
    email: Mapped[Optional[str]] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (UniqueConstraint("provider", "provider_user_id"),)


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    device_id: Mapped[Optional[str]] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime)
