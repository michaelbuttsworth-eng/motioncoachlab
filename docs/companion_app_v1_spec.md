# MotionCoachLab Companion App v1 Spec

## Goal
Build a minimal mobile app to remove beginner friction while keeping chat (Telegram) as the coaching layer.

## Product Positioning
- Chat-first coach, app-light tracker.
- Beginner and return-to-running users first.
- Strava optional, not required.

## v1 Scope (Must Have)
- Auth: email magic link or OTP (no passwords in v1).
- Run tracking: `Start Run`, `Pause`, `Resume`, `Stop`.
- GPS capture: distance, elapsed time, route polyline, average pace.
- Audio cues:
  - Run/walk interval cues.
  - Halfway turnaround cue.
  - Session complete cue.
- Session sync to backend.
- Post-run check-in in app (buttons/sliders): effort, fatigue, pain, session feel.
- Optional handoff to Telegram: “Ask coach for tomorrow”.

## v1 Out of Scope
- Social feed.
- Advanced analytics/VO2max.
- Wearable integrations.
- iMessage/WhatsApp channels.

## User Flows
1. Onboarding
- Choose goal track: `Get Moving`, `Couch to 5K`, `Back to Running`.
- Pick desired start date.
- Pick available days.
- Pick max session time.
- Optional: connect Strava (skip by default).

2. Guided Session
- User taps `Start Today's Session`.
- App runs timer + GPS + interval audio.
- App gives halfway turnaround cue on out-and-back sessions.
- On stop, app uploads run and opens check-in.

3. Coaching Loop
- Backend adapts plan from completion + check-in.
- Telegram sends short coaching summary and next step.

## Screens (v1)
- Welcome / Sign in
- Plan Today
- Live Run (map, elapsed time, interval state)
- Post-run Check-in
- Progress (weekly motion minutes, streak, total distance)
- Settings (audio, units, Strava connect optional)

## Data Model Additions
- `device_sessions`
  - `id`, `user_id`, `started_at`, `ended_at`, `duration_s`, `distance_m`, `source='mobile_gps'`, `route_polyline`, `avg_pace`, `created_at`
- `device_session_events`
  - `id`, `session_id`, `event_type` (`run`, `walk`, `cue_halfway`, `pause`, `resume`), `ts`
- Reuse existing `run_feedback` for check-ins.

## API Endpoints (v1)
- `POST /mobile/session/start`
- `POST /mobile/session/{id}/event`
- `POST /mobile/session/{id}/stop`
- `POST /mobile/session/{id}/checkin`
- `GET /mobile/plan/today/{user_id}`
- `GET /mobile/progress/{user_id}`

## Tech Recommendation
- React Native + Expo (fastest to pilot iOS/Android).
- Background location with Expo Location + Task Manager.
- Text-to-speech/audio cues with Expo AV / Speech.
- Existing FastAPI backend extended with `/mobile/*` routes.

## Privacy / Safety
- Store only coaching-related run metrics.
- No contact scraping, no unrelated phone data.
- Explicit consent for location tracking.
- Per-user data isolation enforced server-side.

## Subscription Path
- Free: onboarding + 2 weeks + basic guided sessions.
- Paid: adaptive coach, full history, progress insights, community goals.

## Delivery Plan
1. Week 1: Backend mobile endpoints + schema + auth token for app.
2. Week 2: Live run screen + GPS + start/stop upload.
3. Week 3: Audio cues + interval engine + halfway cue.
4. Week 4: Post-run check-in + progress screen + TestFlight/internal beta.

## Acceptance Criteria
- New user can onboard and complete first guided run in under 5 minutes.
- Run data saved without Strava.
- Post-run check-in submitted with button inputs only.
- Coach adapts upcoming plan after tough run / pain signal.
