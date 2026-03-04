# Architecture (v1)

## Components
- API: FastAPI (plans, onboarding, users, Strava ingest, community goals)
- Worker: scheduled jobs (weekly planning, Sunday availability check-in, daily check-ins)
- Web: Vite + React for closed pilot UI
- Chat: Telegram bot adapter (calls API)

## Data
- Users, profiles, goals, availability
- Training plans (weekly + daily)
- Runs (from Strava)
- Community goals + contributions

## Strava
OAuth for each user. Store tokens per user.
