# MotionCoachLab Mobile (v1 scaffold)

## Setup
1. `cd /Users/michaelbuttsworth/.openclaw/motioncoachlab/mobile`
2. `npm install`
3. Create `.env` in this folder:

```
EXPO_PUBLIC_API_BASE_URL=http://YOUR_MAC_IP:8000
EXPO_PUBLIC_INTERNAL_KEY=YOUR_INTERNAL_API_KEY
```

Use your Mac LAN IP (not localhost) for testing on phone.

4. `npm run start`

## Auth (pilot)
- App now uses guest auth by default (`Continue as Guest`).
- Guest session token is stored securely on-device.
- Apple/Google/Facebook login buttons are placeholders for the next auth phase.

## Build Profiles
- Development client: `npm run build:ios:dev`
- Internal preview: `npm run build:ios:preview`
- Production build: `npm run build:ios:prod`
- Submit to TestFlight: `npm run submit:ios`

## Included screens
- Plan Today
- Live Run (GPS distance/pace, start/pause/resume/stop, background mode toggle, audio cues, button check-in)
- Progress
- History (recent runs + check-in summary + route map preview)

## Notes
- This is a pilot scaffold.
- GPS includes background mode support (permission required).
- Audio cues are in place for interval phases and halfway turnaround when interval plans exist.
- Route preview map is shown after/while points are captured.
- Backend `/mobile/*` endpoints are implemented and ready.

## Docs
- TestFlight pipeline: `/Users/michaelbuttsworth/.openclaw/motioncoachlab/mobile/docs/testflight_pipeline.md`
- Social login roadmap: `/Users/michaelbuttsworth/.openclaw/motioncoachlab/mobile/docs/social_login_roadmap.md`
