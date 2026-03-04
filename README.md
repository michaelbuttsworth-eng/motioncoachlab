# MotionCoachLab

Virtual coach platform (Telegram-first) with onboarding, planning, progress, and community goals.

## Structure
- `services/api`: FastAPI backend (plans, onboarding, users, community, Strava ingest)
- `services/worker`: background tasks (weekly planning, Sunday availability checks, daily check-ins, data sync)
- `web`: closed website (program, history, progress, community)
- `docs`: architecture + onboarding specs
- `scripts`: local tooling

## Quick start (local)
1. Copy `.env.example` to `.env` and fill values
2. Start services:

```bash
cd /Users/michaelbuttsworth/.openclaw/motioncoachlab
python -m venv .venv
source .venv/bin/activate
pip install -r services/api/requirements.txt
uvicorn app.main:app --app-dir services/api --reload
```

```bash
cd /Users/michaelbuttsworth/.openclaw/motioncoachlab/web
npm install
npm run dev
```

## Notes
- Strava-only for v1
- Apple Health planned for phase 2
- Pilot deployment plan: `docs/pilot_deployment_plan.md`
