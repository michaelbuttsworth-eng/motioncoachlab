import ActivityKit
import AVFoundation
import AudioToolbox
import Foundation
import React
import UIKit

@available(iOS 16.2, *)
struct MotionCoachLiveActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    var phase: String
    var phaseLabel: String
    var elapsedSec: Int
    var segmentRemainingSec: Int
    var sessionStartedAtEpoch: Double
    var segmentEndsAtEpoch: Double
    var distanceM: Double
    var paceMinPerKm: Double
    var progress: Double
    var isPaused: Bool
    var intervalCurrent: Int
    var intervalTotal: Int
  }

  var sessionId: String
}

@objc(MCLiveActivityManager)
class MCLiveActivityManager: NSObject {
  private struct NativeCue {
    let atSec: Double
    let cueType: String
    let phase: String
    let phaseLabel: String
    let segmentStartAtSec: Double
    let segmentEndsAtSec: Double
    let intervalCurrent: Int
    let intervalTotal: Int
  }

  @available(iOS 16.2, *)
  private static var currentActivity: Activity<MotionCoachLiveActivityAttributes>?
  private static var cueTimers: [DispatchSourceTimer] = []
  private static var cuePlayer: AVAudioPlayer?
  private static var cueTimeline: [NativeCue] = []
  private static var cueSessionStartedAtEpoch: Double = 0
  private static let cueFileMap: [String: String] = [
    "cue_warmup_intro": "warmup_intro.wav",
    "cue_warmup": "warmup.wav",
    "cue_prerun": "prerun.wav",
    "cue_run": "run.wav",
    "cue_walk": "walk.wav",
    "cue_cooldown": "cooldown.wav",
    "cue_summary": "summary.wav",
    "cue_halfway": "halfway.wav"
  ]

  @objc
  static func requiresMainQueueSetup() -> Bool {
    return false
  }

  @objc(start:resolver:rejecter:)
  func start(payload: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard #available(iOS 16.2, *) else {
      resolve(["ok": false, "reason": "unsupported_ios"])
      return
    }

    guard ActivityAuthorizationInfo().areActivitiesEnabled else {
      resolve(["ok": false, "reason": "activities_disabled"])
      return
    }

    let sessionId = String(describing: payload["sessionId"] ?? "")
    if sessionId.isEmpty {
      reject("E_INVALID_ARGS", "sessionId is required", nil)
      return
    }

    let state = Self.state(from: payload)
    let attributes = MotionCoachLiveActivityAttributes(sessionId: sessionId)

    Task {
      do {
        if let existing = Self.currentActivity {
          await existing.update(ActivityContent(state: state, staleDate: nil))
          resolve(["ok": true, "id": existing.id, "updated": true])
          return
        }
        let activity = try Activity.request(attributes: attributes, content: ActivityContent(state: state, staleDate: nil), pushType: nil)
        Self.currentActivity = activity
        resolve(["ok": true, "id": activity.id, "updated": false])
      } catch {
        reject("E_START_FAILED", "Failed to start Live Activity", error)
      }
    }
  }

  @objc(update:resolver:rejecter:)
  func update(payload: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard #available(iOS 16.2, *) else {
      resolve(["ok": false, "reason": "unsupported_ios"])
      return
    }

    let state = Self.state(from: payload)

    Task {
      if let activity = Self.currentActivity {
        await activity.update(ActivityContent(state: state, staleDate: nil))
        resolve(["ok": true, "id": activity.id])
        return
      }

      // Recover activity handle after app relaunch.
      if let existing = Activity<MotionCoachLiveActivityAttributes>.activities.first {
        Self.currentActivity = existing
        await existing.update(ActivityContent(state: state, staleDate: nil))
        resolve(["ok": true, "id": existing.id, "recovered": true])
        return
      }

      resolve(["ok": false, "reason": "no_activity"])
    }
  }

  @objc(end:resolver:rejecter:)
  func end(payload: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard #available(iOS 16.2, *) else {
      resolve(["ok": false, "reason": "unsupported_ios"])
      return
    }

    let state = Self.state(from: payload)

    Task {
      let activity = Self.currentActivity ?? Activity<MotionCoachLiveActivityAttributes>.activities.first
      guard let activity else {
        resolve(["ok": false, "reason": "no_activity"])
        return
      }

      await activity.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: .immediate)
      Self.currentActivity = nil
      resolve(["ok": true, "id": activity.id])
    }
  }

  @objc(startCues:resolver:rejecter:)
  func startCues(payload: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard #available(iOS 16.2, *) else {
      resolve(["ok": false, "reason": "unsupported_ios"])
      return
    }
    let cues = payload["cues"] as? [NSDictionary] ?? []
    let elapsedSec = (payload["elapsedSec"] as? NSNumber)?.doubleValue ?? 0
    let sessionStartedAtEpoch = (payload["sessionStartedAtEpoch"] as? NSNumber)?.doubleValue ?? (Date().timeIntervalSince1970 - elapsedSec)
    Self.cueSessionStartedAtEpoch = sessionStartedAtEpoch
    Self.cueTimeline = cues.compactMap(Self.parseCue).sorted { $0.atSec < $1.atSec }
    Self.clearCueTimers()
    Self.configureAudioSession()

    for cue in Self.cueTimeline {
      let atSec = cue.atSec
      let cueType = cue.cueType
      let delaySec = max(0, atSec - elapsedSec)
      let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
      timer.schedule(deadline: .now() + delaySec)
      timer.setEventHandler {
        Self.playCueIfBackground(cueType: cueType)
        Self.updateLiveActivityForCue(cue)
      }
      timer.resume()
      Self.cueTimers.append(timer)
    }

    resolve(["ok": true, "armed": Self.cueTimers.count])
  }

  @objc(stopCues:rejecter:)
  func stopCues(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    Self.clearCueTimers()
    Self.cuePlayer?.stop()
    Self.cuePlayer = nil
    Self.cueTimeline = []
    resolve(["ok": true])
  }

  @available(iOS 16.2, *)
  private static func state(from payload: NSDictionary) -> MotionCoachLiveActivityAttributes.ContentState {
    let phase = String(describing: payload["phase"] ?? "Running")
    let phaseLabel = String(describing: payload["phaseLabel"] ?? phase)
    let elapsedSec = (payload["elapsedSec"] as? NSNumber)?.intValue ?? 0
    let segmentRemainingSec = (payload["segmentRemainingSec"] as? NSNumber)?.intValue ?? 0
    let sessionStartedAtEpoch = (payload["sessionStartedAtEpoch"] as? NSNumber)?.doubleValue ?? Date().timeIntervalSince1970
    let segmentEndsAtEpoch = (payload["segmentEndsAtEpoch"] as? NSNumber)?.doubleValue ?? Date().timeIntervalSince1970
    let distanceM = (payload["distanceM"] as? NSNumber)?.doubleValue ?? 0
    let pace = (payload["paceMinPerKm"] as? NSNumber)?.doubleValue ?? 0
    let progressRaw = (payload["progress"] as? NSNumber)?.doubleValue ?? 0
    let paused = (payload["isPaused"] as? NSNumber)?.boolValue ?? false
    let intervalCurrent = (payload["intervalCurrent"] as? NSNumber)?.intValue ?? 0
    let intervalTotal = (payload["intervalTotal"] as? NSNumber)?.intValue ?? 0

    return MotionCoachLiveActivityAttributes.ContentState(
      phase: phase,
      phaseLabel: phaseLabel,
      elapsedSec: max(0, elapsedSec),
      segmentRemainingSec: max(0, segmentRemainingSec),
      sessionStartedAtEpoch: sessionStartedAtEpoch,
      segmentEndsAtEpoch: max(sessionStartedAtEpoch, segmentEndsAtEpoch),
      distanceM: max(0, distanceM),
      paceMinPerKm: max(0, pace),
      progress: min(1, max(0, progressRaw)),
      isPaused: paused,
      intervalCurrent: max(0, intervalCurrent),
      intervalTotal: max(0, intervalTotal)
    )
  }

  private static func clearCueTimers() {
    cueTimers.forEach { $0.cancel() }
    cueTimers.removeAll()
  }

  private static func parseCue(_ raw: NSDictionary) -> NativeCue? {
    let atSec = (raw["atSec"] as? NSNumber)?.doubleValue ?? -1
    if atSec < 0 { return nil }
    let cueType = String(describing: raw["cueType"] ?? raw["type"] ?? "")
    if cueType.isEmpty { return nil }
    let phase = String(describing: raw["phase"] ?? "Running")
    let phaseLabel = String(describing: raw["phaseLabel"] ?? phase)
    let segmentStartAtSec = (raw["segmentStartAtSec"] as? NSNumber)?.doubleValue ?? atSec
    let segmentEndsAtSec = (raw["segmentEndsAtSec"] as? NSNumber)?.doubleValue ?? atSec
    let intervalCurrent = (raw["intervalCurrent"] as? NSNumber)?.intValue ?? 0
    let intervalTotal = (raw["intervalTotal"] as? NSNumber)?.intValue ?? 0
    return NativeCue(
      atSec: atSec,
      cueType: cueType,
      phase: phase,
      phaseLabel: phaseLabel,
      segmentStartAtSec: segmentStartAtSec,
      segmentEndsAtSec: segmentEndsAtSec,
      intervalCurrent: intervalCurrent,
      intervalTotal: intervalTotal
    )
  }

  @available(iOS 16.2, *)
  private static func updateLiveActivityForCue(_ cue: NativeCue) {
    Task {
      let activity = currentActivity ?? Activity<MotionCoachLiveActivityAttributes>.activities.first
      guard let activity else { return }
      currentActivity = activity

      let now = Date().timeIntervalSince1970
      let sessionStart = cueSessionStartedAtEpoch > 0 ? cueSessionStartedAtEpoch : now
      let elapsed = max(0, Int(now - sessionStart))
      let segmentEndEpoch = max(now, sessionStart + cue.segmentEndsAtSec)
      let segmentRemaining = max(0, Int(segmentEndEpoch - now))
      let segmentDuration = max(1.0, cue.segmentEndsAtSec - cue.segmentStartAtSec)
      let segmentElapsed = max(0.0, min(segmentDuration, Double(elapsed) - cue.segmentStartAtSec))
      let blockProgress = min(1.0, max(0.0, segmentElapsed / segmentDuration))

      var state = activity.content.state
      state.phase = cue.phase
      state.phaseLabel = cue.phaseLabel
      state.elapsedSec = elapsed
      state.segmentEndsAtEpoch = segmentEndEpoch
      state.segmentRemainingSec = segmentRemaining
      state.progress = blockProgress
      state.intervalCurrent = max(0, cue.intervalCurrent)
      state.intervalTotal = max(0, cue.intervalTotal)
      await activity.update(ActivityContent(state: state, staleDate: nil))
    }
  }

  private static func configureAudioSession() {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers, .mixWithOthers])
      try session.setActive(true, options: [])
    } catch {
      // ignore; fallback to notification sounds
    }
  }

  private static func playCueIfBackground(cueType: String) {
    if UIApplication.shared.applicationState == .active {
      return
    }
    guard let file = cueFileMap[cueType] else { return }
    guard let url = Bundle.main.url(forResource: file, withExtension: nil) else { return }
    do {
      configureAudioSession()
      let player = try AVAudioPlayer(contentsOf: url)
      cuePlayer = player
      player.volume = 1.0
      player.prepareToPlay()
      player.play()
      AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
    } catch {
      // ignore play failures
    }
  }
}
