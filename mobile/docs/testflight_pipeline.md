# TestFlight Pipeline (Xcode + App Store Connect)

## Objective
Get a repeatable path from local development to internal TestFlight pilot builds.

## 1) One-time setup
1. Install tooling:
- `xcode-select --install` (if missing)
- Install Xcode from the App Store
- Install CocoaPods: `sudo gem install cocoapods` (if missing)

2. Login to Apple in Xcode:
- Xcode -> Settings -> Accounts -> add Apple ID with App Store Connect access

3. Confirm app config:
- iOS bundle id in Xcode target settings: `com.motioncoachlab.app`
- Watch target bundle id: `com.motioncoachlab.app.watchkitapp`
- Live Activity extension bundle id is valid and signed

4. Set env file for local runs:
- copy `.env.example` to `.env`
- set `EXPO_PUBLIC_API_BASE_URL` to production API for release builds
- set `EXPO_PUBLIC_INTERNAL_KEY`

## 2) Local development
- `npm install`
- `npm run ios` (or run from Xcode)

For native behaviors (background location/maps/watch), always validate on a real device.

## 3) Prepare iOS archive
1. `cd /Users/michaelbuttsworth/Projects/apps/motioncoachlab/mobile/ios`
2. `pod install`
3. `open MotionCoachLab.xcworkspace`
4. Select scheme `MotionCoachLab`
5. Select destination `Any iOS Device (arm64)`
6. Confirm Signing & Capabilities for:
- MotionCoachLab
- MotionCoachLiveActivity extension
- MotionCoachWatchApp Watch App

## 4) Build and upload
1. In Xcode: `Product` -> `Archive`
2. In Organizer: `Distribute App` -> `App Store Connect` -> `Upload`
3. Wait for processing in App Store Connect (TestFlight tab)

## 5) Add internal testers
1. App Store Connect -> My Apps -> Motion Coach -> TestFlight
2. Add build to Internal Testing group
3. Add users and notify testers

## 6) Release checklist per build
- API healthy (`/health`)
- Start/Pause/Resume/Stop run works
- Background tracking works on a real device
- Route preview map renders after run
- Post-run check-in saves
- History tab shows latest run + check-in

## Notes
- Use real iPhone tests for background GPS reliability.
- If changing bundle ids later, update all iOS targets together.
