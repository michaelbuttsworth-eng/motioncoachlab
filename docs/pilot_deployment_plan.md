# Pilot Deployment Plan (Proper Fix)

## Goal
Make app + chat work away from local Wi-Fi by hosting API on a public HTTPS endpoint.

## Recommended stack (phase 1)
- API hosting: Railway (or Render/Fly)
- Database: managed Postgres
- Domain: `api.motioncoachlab.com`
- Mobile app env: `EXPO_PUBLIC_API_BASE_URL=https://api.motioncoachlab.com`

## Why this solves your issue
Your phone on 5G cannot reach `http://192.168.x.x:8000`.
Public API over HTTPS removes local network dependency.

## 1) Deploy API
Use Dockerfile at:
- `/Users/michaelbuttsworth/.openclaw/motioncoachlab/services/api/Dockerfile`

Required env vars:
- `DATABASE_URL` (Postgres)
- `MOTIONCOACH_INTERNAL_API_KEY` (long random string)
- `CORS_ALLOW_ORIGINS` (comma-separated)
- `STRAVA_CLIENT_ID`
- `STRAVA_CLIENT_SECRET`
- `STRAVA_REDIRECT_URI` (new public callback URL)

Suggested `CORS_ALLOW_ORIGINS` for pilot:
- `https://motioncoachlab.com,https://www.motioncoachlab.com,exp://127.0.0.1:8081`

Health check:
- `GET /health`

## 2) Switch Strava callback to production
In Strava app settings, add production callback:
- `https://api.motioncoachlab.com/strava/callback`

Keep local callback only for local dev.

## 3) Mobile app switch
For local dev-client testing with remote API:
- update `/Users/michaelbuttsworth/.openclaw/motioncoachlab/mobile/.env`
- set `EXPO_PUBLIC_API_BASE_URL=https://api.motioncoachlab.com`

For EAS/TestFlight builds:
- set EAS environment variable `EXPO_PUBLIC_API_BASE_URL` in `preview` and `production` envs.

## 4) Telegram bot + workers
Current local setup can continue during solo test.
Before multi-user pilot, move bot/worker to cloud as separate services with same API base URL.

## 5) Go-live checks
- App over 5G loads Plan/Run/Progress/History
- Start/Stop run writes to remote DB
- Check-ins sync
- `/bug` logs to pilot feedback
- Google Sheet sync still updates from worker

## 6) Rollout sequence
1. Deploy API + Postgres
2. Point mobile app to remote API
3. Validate your own 2-week solo test on 5G
4. Freeze build and push TestFlight for 5 users
