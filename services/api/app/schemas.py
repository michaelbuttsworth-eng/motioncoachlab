from __future__ import annotations

from datetime import date, datetime
from typing import Optional
from pydantic import BaseModel


class Health(BaseModel):
    status: str


class UserCreate(BaseModel):
    name: str
    email: Optional[str] = None
    telegram_id: Optional[str] = None


class UserOut(BaseModel):
    id: int
    name: str
    email: Optional[str]
    telegram_id: Optional[str]
    created_at: datetime

    class Config:
        from_attributes = True


class ProfileCreate(BaseModel):
    goal_mode: Optional[str] = None
    goal_primary: str
    goal_date: Optional[date] = None
    start_date: Optional[date] = None
    timeline_weeks: Optional[int] = None
    ability_level: str
    weekly_availability: int
    time_per_run: str
    recent_runs_per_week: Optional[int] = None
    longest_recent_min: Optional[int] = None
    continuous_run_min: Optional[int] = None
    run_walk_ok: Optional[str] = None
    injury_status: str
    preferred_days: str


class ProfileOut(ProfileCreate):
    id: int
    user_id: int

    class Config:
        from_attributes = True


class WeeklyAvailabilityCreate(BaseModel):
    week_start: date
    mon: bool
    tue: bool
    wed: bool
    thu: bool
    fri: bool
    sat: bool
    sun: bool


class WeeklyAvailabilityOut(WeeklyAvailabilityCreate):
    id: int
    user_id: int

    class Config:
        from_attributes = True


class OnboardingUpdate(BaseModel):
    current_step: Optional[int] = None
    goal_mode: Optional[str] = None
    goal_primary: Optional[str] = None
    goal_date: Optional[date] = None
    start_date: Optional[date] = None
    timeline_weeks: Optional[int] = None
    ability_level: Optional[str] = None
    weekly_availability: Optional[int] = None
    time_per_run: Optional[str] = None
    recent_runs_per_week: Optional[int] = None
    longest_recent_min: Optional[int] = None
    continuous_run_min: Optional[int] = None
    run_walk_ok: Optional[str] = None
    injury_status: Optional[str] = None
    preferred_days: Optional[str] = None
    engagement_mode: Optional[str] = None


class OnboardingOut(OnboardingUpdate):
    id: int
    user_id: int
    updated_at: datetime

    class Config:
        from_attributes = True


class StravaAuthOut(BaseModel):
    url: str


class StravaSyncOut(BaseModel):
    added: int
    total: int


class StravaExchangeIn(BaseModel):
    code: str
    state: str


class StravaExchangeOut(BaseModel):
    status: str


class StravaStatusOut(BaseModel):
    connected: bool
    athlete_name: Optional[str] = None
    athlete_id: Optional[str] = None


class PlanDayOut(BaseModel):
    id: int
    user_id: int
    day: date
    session_type: str
    planned_km: int
    notes: Optional[str] = None

    class Config:
        from_attributes = True


class PlanWeekViewOut(BaseModel):
    week_start: date
    focus: str
    target_km: int
    days: list[PlanDayOut]


class PlanGenerateOut(BaseModel):
    weeks: int
    days: int
    start_date: date
    end_date: date


class LatestRunOut(BaseModel):
    id: int
    user_id: int
    source: str
    source_id: str
    start_time: datetime
    distance_m: int
    duration_s: int

    class Config:
        from_attributes = True


class ManualRunCreate(BaseModel):
    duration_min: float
    distance_km: Optional[float] = None
    started_at: Optional[datetime] = None


class RunFeedbackCreate(BaseModel):
    run_id: int
    effort: str
    fatigue: str
    pain: str
    session_feel: str
    notes: Optional[str] = None


class RunFeedbackOut(RunFeedbackCreate):
    id: int
    user_id: int
    submitted_at: datetime

    class Config:
        from_attributes = True


class RunFeedbackSubmitOut(BaseModel):
    feedback: RunFeedbackOut
    actions_applied: list[str]


class AchievementOut(BaseModel):
    id: int
    user_id: int
    run_id: Optional[int]
    code: str
    title: str
    detail: str
    created_at: datetime

    class Config:
        from_attributes = True


class AchievementCheckOut(BaseModel):
    created: list[AchievementOut]


class PilotFeedbackCreate(BaseModel):
    source: str = "chat"
    category: str = "general"
    text: str


class PilotFeedbackOut(PilotFeedbackCreate):
    id: int
    user_id: int
    created_at: datetime

    class Config:
        from_attributes = True


class PlanReviewOut(BaseModel):
    user_id: int
    week_start: date
    planned_km: float
    actual_km: float
    adherence_ratio: float
    planned_sessions: int
    completed_sessions: int
    missed_sessions: int
    adjustment_factor: float
    next_week_start: date
    old_next_week_target_km: int
    new_next_week_target_km: int


class BehaviorSuggestionOut(BaseModel):
    code: str
    title: str
    reason: str
    action: str


class BehaviorAnalysisOut(BaseModel):
    user_id: int
    window_weeks: int
    period_start: date
    period_end: date
    planned_sessions: int
    completed_sessions: int
    delayed_sessions: int
    long_run_misses: int
    planned_km: float
    actual_km: float
    reliability_score: float
    adherence_ratio: float
    weekday_success: dict[str, float]
    suggestions: list[BehaviorSuggestionOut]
    applied_actions: list[str]


class MobileSessionStartIn(BaseModel):
    user_id: int
    started_at: Optional[datetime] = None


class MobileSessionEventIn(BaseModel):
    event_type: str
    ts: Optional[datetime] = None
    payload_json: Optional[str] = None


class MobileSessionStopIn(BaseModel):
    ended_at: Optional[datetime] = None
    distance_m: int
    duration_s: int
    route_polyline: Optional[str] = None


class MobileSessionCheckinIn(BaseModel):
    effort: str
    fatigue: str
    pain: str
    session_feel: str
    notes: Optional[str] = None


class MobileSessionOut(BaseModel):
    id: int
    user_id: int
    status: str
    started_at: datetime
    ended_at: Optional[datetime] = None
    duration_s: Optional[int] = None
    distance_m: Optional[int] = None
    source: str
    route_polyline: Optional[str] = None
    avg_pace_min_km: Optional[float] = None
    run_id: Optional[int] = None
    created_at: datetime

    class Config:
        from_attributes = True


class MobilePlanTodayOut(BaseModel):
    user_id: int
    day: date
    session_type: str
    planned_km: float
    notes: Optional[str] = None
    interval: Optional[dict] = None


class MobileProgressOut(BaseModel):
    user_id: int
    week_start: date
    week_motion_min: float
    week_distance_km: float
    total_distance_km: float
    run_streak_days: int


class MobileHistoryItemOut(BaseModel):
    run_id: int
    started_at: datetime
    source: str
    distance_m: int
    duration_s: int
    pace_min_km: Optional[float] = None
    route_polyline: Optional[str] = None
    effort: Optional[str] = None
    fatigue: Optional[str] = None
    pain: Optional[str] = None
    session_feel: Optional[str] = None


class MobileHistoryOut(BaseModel):
    user_id: int
    items: list[MobileHistoryItemOut]


class PilotReportOut(BaseModel):
    user_id: int
    days: int
    period_start: date
    period_end: date
    sessions_started: int
    sessions_completed: int
    checkins_submitted: int
    total_distance_km: float
    total_motion_min: float


class AuthGuestIn(BaseModel):
    name: Optional[str] = None
    device_id: Optional[str] = None


class AuthGuestOut(BaseModel):
    token: str
    user_id: int
    name: str
    expires_at: datetime


class AuthMeOut(BaseModel):
    user_id: int
    name: str
    email: Optional[str] = None


class AuthLinkIn(BaseModel):
    token: Optional[str] = None
    code: Optional[str] = None
