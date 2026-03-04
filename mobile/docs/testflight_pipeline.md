# TestFlight Pipeline (Expo + EAS)

## Objective
Get a repeatable path from local development to internal TestFlight pilot builds.

## 1) One-time setup
1. Install tooling:
- `npm i -g eas-cli`
- `xcode-select --install` (if missing)

2. Login to Expo and Apple:
- `eas login`
- `eas whoami`

3. Confirm app config:
- iOS bundle id in `app.json`: `com.motioncoachlab.app`
- Android package in `app.json`: `com.motioncoachlab.app`

4. Set env file for local runs:
- copy `.env.example` to `.env`
- set `EXPO_PUBLIC_API_BASE_URL` to your Mac LAN IP + `:8000`
- set `EXPO_PUBLIC_INTERNAL_KEY`

## 2) Local development
- `npm install`
- `npm run start`

For native behaviors (background location/maps), prefer a dev build over Expo Go.

## 3) Build development client (internal)
- `npm run build:ios:dev`

This gives an installable build for direct device testing.

## 4) Build internal preview for pilot
- `npm run build:ios:preview`

Use this for internal team testing before TestFlight external groups.

## 5) Production/TestFlight build
1. Update `mobile/eas.json`:
- replace `REPLACE_APP_STORE_CONNECT_APP_ID` in `submit.production.ios.ascAppId`

2. Build production binary:
- `npm run build:ios:prod`

3. Submit to TestFlight:
- `npm run submit:ios`

## 6) Release checklist per build
- API healthy (`/health`)
- Start/Pause/Resume/Stop run works
- Background tracking works on a real device
- Route preview map renders after run
- Post-run check-in saves
- History tab shows latest run + check-in

## Notes
- Use real iPhone tests for background GPS reliability.
- If changing bundle id later, do it before wider distribution.
