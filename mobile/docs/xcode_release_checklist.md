# Xcode Release Checklist (Internal Testers)

## Scope
Use this checklist before each internal TestFlight release.

## 1) Pre-build checks
- [ ] Backend production API is healthy: `GET /health` returns `{"status":"ok"}`
- [ ] Mobile `.env` points to production API
- [ ] `npm run typecheck` passes
- [ ] iPhone real-device smoke test completed (start/pause/resume/stop)

## 2) Open project
```bash
cd /Users/michaelbuttsworth/Projects/apps/motioncoachlab/mobile
npm install
cd ios
pod install
open MotionCoachLab.xcworkspace
```

## 3) Xcode signing and versions
- [ ] Scheme: `MotionCoachLab`
- [ ] Destination: `Any iOS Device (arm64)`
- [ ] Team selected for all targets
- [ ] Provisioning profile valid for all targets:
  - MotionCoachLab
  - MotionCoachLiveActivity extension
  - MotionCoachWatchApp Watch App
- [ ] `MARKETING_VERSION` updated if needed
- [ ] `CURRENT_PROJECT_VERSION` incremented

## 4) Archive and upload
- [ ] `Product` -> `Archive` succeeds
- [ ] Organizer -> `Distribute App` -> `App Store Connect` -> `Upload`
- [ ] Upload validation passes

## 5) App Store Connect
- [ ] Build processing completed in TestFlight
- [ ] Internal test group assigned
- [ ] Release notes added (what changed, known issues)
- [ ] Testers notified

## 6) Post-upload verification
- [ ] Install build from TestFlight on iPhone
- [ ] Verify onboarding and permission order
- [ ] Verify rest day messaging consistency (Plan/Run/Progress)
- [ ] Verify history notes display and collapse behavior
- [ ] Verify route map appears for sessions with GPS route points
- [ ] Verify background/locked-phone tracking on real walk/run

## 7) Known blocker checks
- [ ] No duplicate runs after stop/retry
- [ ] Notes persist into history from post-run check-in
- [ ] Guided run prompt appears each start for guided program users
