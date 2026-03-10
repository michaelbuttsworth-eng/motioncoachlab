import Foundation
import HealthKit
import WatchConnectivity
import WatchKit
import Combine

enum WorkoutMode: String {
  case run
  case walk
}

struct GuidedLeg {
  let phase: String
  let label: String
  let durationSec: Int
  let intervalCurrent: Int
  let intervalTotal: Int
}

struct WorkoutSummary {
  let mode: WorkoutMode
  let durationSec: Int
  let distanceM: Double
  let paceMinPerKm: Double
  let heartRate: Double
  let endedAt: Date
}

final class WorkoutManager: NSObject, ObservableObject, HKWorkoutSessionDelegate, HKLiveWorkoutBuilderDelegate, WCSessionDelegate {
  @Published var authorized = false
  @Published var watchReachable = false
  @Published var isRunning = false
  @Published var isPaused = false
  @Published var mode: WorkoutMode = .run
  @Published var statusText = "Ready"
  @Published var elapsedSec = 0
  @Published var distanceM: Double = 0
  @Published var heartRate: Double = 0
  @Published var paceMinPerKm: Double = 0
  @Published var phaseLabel = "Idle"
  @Published var segmentRemainingSec = 0
  @Published var intervalCurrent = 0
  @Published var intervalTotal = 0
  @Published var countdownSec = 0
  @Published var lastSummary: WorkoutSummary?
  @Published var reviewPending = false
  @Published var reviewFeel = ""

  private let healthStore = HKHealthStore()
  private var workoutSession: HKWorkoutSession?
  private var workoutBuilder: HKLiveWorkoutBuilder?
  private var sessionStartedAt: Date?
  private var tickTimer: Timer?
  private var pauseBeganAt: Date?
  private var pausedAccumSec: TimeInterval = 0
  private var guidedTimeline: [GuidedLeg] = []
  private var currentLegIndex = 0
  private var legStartedAt: Date?
  private var legPausedAccumSec: TimeInterval = 0
  private var legPauseBeganAt: Date?
  private var lastWatchPayloadSentAt: Date = .distantPast
  private var lastDistanceSent: Double = -1
  private var lastElapsedSent = -1
  private var countdownTimer: Timer?
  private var pendingStart: (mode: WorkoutMode, guidedLegs: [GuidedLeg])?
  private var endingRequestedByPhone = false
  
  private func currentStatePayload() -> [String: Any] {
    return [
      "isRunning": isRunning,
      "isPaused": isPaused,
      "mode": mode.rawValue,
      "guided": !guidedTimeline.isEmpty,
      "elapsedSec": elapsedSec,
      "distanceM": distanceM,
      "heartRate": heartRate,
      "paceMinPerKm": paceMinPerKm,
      "phaseLabel": phaseLabel,
      "segmentRemainingSec": segmentRemainingSec,
      "intervalCurrent": intervalCurrent,
      "intervalTotal": intervalTotal,
      "reviewPending": reviewPending,
      "reviewFeel": reviewFeel,
    ]
  }

  private func onMain(_ block: @escaping () -> Void) {
    if Thread.isMainThread {
      block()
    } else {
      DispatchQueue.main.async(execute: block)
    }
  }

  override init() {
    super.init()
    if WCSession.isSupported() {
      let session = WCSession.default
      session.delegate = self
      session.activate()
      onMain {
        self.watchReachable = session.isReachable
      }
    }
  }

  func requestAuthorization() {
    guard HKHealthStore.isHealthDataAvailable() else {
      DispatchQueue.main.async {
        self.authorized = false
        self.statusText = "Health unavailable"
      }
      return
    }
    let toShare: Set<HKSampleType> = [
      HKObjectType.workoutType(),
      HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning)!,
    ]
    let toRead: Set<HKObjectType> = [
      HKQuantityType.quantityType(forIdentifier: .heartRate)!,
      HKQuantityType.quantityType(forIdentifier: .distanceWalkingRunning)!,
    ]
    healthStore.requestAuthorization(toShare: toShare, read: toRead) { granted, _ in
      DispatchQueue.main.async {
        self.authorized = granted
        self.statusText = granted ? "Ready" : "Health permission needed"
      }
    }
  }

  func startSimpleWorkout(mode: WorkoutMode) {
    beginCountdown(mode: mode, guidedLegs: [])
  }

  func startDefaultGuidedRun() {
    var legs: [GuidedLeg] = []
    legs.append(GuidedLeg(phase: "warmup", label: "Warm-up", durationSec: 300, intervalCurrent: 0, intervalTotal: 8))
    for idx in 1...8 {
      legs.append(GuidedLeg(phase: "run", label: "Run \(idx)/8", durationSec: 60, intervalCurrent: idx, intervalTotal: 8))
      legs.append(GuidedLeg(phase: "walk", label: "Walk \(idx)/8", durationSec: 90, intervalCurrent: idx, intervalTotal: 8))
    }
    legs.append(GuidedLeg(phase: "cooldown", label: "Cool-down", durationSec: 300, intervalCurrent: 8, intervalTotal: 8))
    beginCountdown(mode: .run, guidedLegs: legs)
  }

  private func beginCountdown(mode: WorkoutMode, guidedLegs: [GuidedLeg]) {
    guard !isRunning else { return }
    pendingStart = (mode, guidedLegs)
    onMain {
      self.countdownSec = 5
      self.statusText = "Get ready"
    }
    playHaptic(.click)
    countdownTimer?.invalidate()
    countdownTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
      guard let self else { return }
      if self.countdownSec <= 1 {
        self.countdownTimer?.invalidate()
        self.countdownTimer = nil
        self.onMain {
          self.countdownSec = 0
        }
        if let pending = self.pendingStart {
          self.pendingStart = nil
          self.startWorkout(mode: pending.mode, guidedLegs: pending.guidedLegs)
        }
        return
      }
      self.onMain {
        self.countdownSec -= 1
      }
      self.playHaptic(.click)
    }
  }

  private func startWorkout(mode: WorkoutMode, guidedLegs: [GuidedLeg], startedAt: Date? = nil) {
    guard authorized else {
      requestAuthorization()
      return
    }
    if isRunning { return }

    do {
      let config = HKWorkoutConfiguration()
      config.activityType = (mode == .run) ? .running : .walking
      config.locationType = .outdoor

      let session = try HKWorkoutSession(healthStore: healthStore, configuration: config)
      let builder = session.associatedWorkoutBuilder()
      builder.dataSource = HKLiveWorkoutDataSource(healthStore: healthStore, workoutConfiguration: config)
      session.delegate = self
      builder.delegate = self

      let now = Date()
      let start: Date
      // Accept a phone-provided start time from much earlier so opening the watch app mid-run
      // mirrors the in-progress session instead of restarting a fresh timer.
      if let provided = startedAt, provided <= now.addingTimeInterval(1), provided >= now.addingTimeInterval(-12 * 60 * 60) {
        start = provided
      } else {
        start = now
      }
      sessionStartedAt = start
      legStartedAt = start
      pausedAccumSec = 0
      pauseBeganAt = nil
      guidedTimeline = guidedLegs
      currentLegIndex = 0
      onMain {
        self.distanceM = 0
        self.elapsedSec = 0
        self.heartRate = 0
        self.paceMinPerKm = 0
        self.lastSummary = nil
        self.mode = mode
        self.intervalCurrent = 0
        self.intervalTotal = 0
      }
      legPausedAccumSec = 0
      legPauseBeganAt = nil
      applyCurrentLegState()

      workoutSession = session
      workoutBuilder = builder
      onMain {
        self.isRunning = true
        self.isPaused = false
        self.statusText = mode == .run ? "Running" : "Walking"
      }
      startTickTimer()
      playHaptic(.start)

      session.startActivity(with: start)
      builder.beginCollection(withStart: start) { [weak self] success, _ in
        guard let self else { return }
        if !success {
          DispatchQueue.main.async { self.statusText = "Start failed" }
        } else {
          self.sendWatchEvent(type: "workout_started", extra: [
            "mode": mode.rawValue,
            "guided": !guidedLegs.isEmpty,
            "elapsedSec": 0,
            "distanceM": 0,
          ])
          self.sendWatchEvent(type: "workout_state", extra: self.currentStatePayload())
        }
      }
    } catch {
      DispatchQueue.main.async {
        self.statusText = "Start failed"
      }
    }
  }

  func pause() {
    guard isRunning, !isPaused, let session = workoutSession else { return }
    pauseBeganAt = Date()
    legPauseBeganAt = Date()
    session.pause()
    onMain {
      self.isPaused = true
      self.statusText = "Paused"
    }
    playHaptic(.stop)
    sendWatchEvent(type: "workout_paused")
  }

  func resume() {
    guard isRunning, isPaused, let session = workoutSession else { return }
    if let pauseStart = pauseBeganAt {
      pausedAccumSec += Date().timeIntervalSince(pauseStart)
    }
    if let legPauseStart = legPauseBeganAt {
      legPausedAccumSec += Date().timeIntervalSince(legPauseStart)
    }
    pauseBeganAt = nil
    legPauseBeganAt = nil
    session.resume()
    onMain {
      self.isPaused = false
      self.statusText = self.mode == .run ? "Running" : "Walking"
    }
    playHaptic(.start)
    sendWatchEvent(type: "workout_resumed")
  }

  func end() {
    guard isRunning, let session = workoutSession else { return }
    session.end()
  }

  func endFromWatch() {
    endingRequestedByPhone = false
    end()
  }

  func selectReviewFeel(_ feel: String) {
    onMain {
      self.reviewFeel = feel
    }
  }

  func saveReview() {
    guard reviewPending else { return }
    sendWatchEvent(type: "workout_review", extra: ["feel": reviewFeel])
    sendWatchEvent(type: "workout_state", extra: currentStatePayload())
    onMain {
      self.reviewPending = false
      self.reviewFeel = ""
      self.statusText = "Ready"
    }
  }

  func discardReview() {
    guard reviewPending else { return }
    sendWatchEvent(type: "workout_review_discarded")
    sendWatchEvent(type: "workout_state", extra: currentStatePayload())
    onMain {
      self.reviewPending = false
      self.reviewFeel = ""
      self.statusText = "Ready"
    }
  }

  private func startTickTimer() {
    tickTimer?.invalidate()
    tickTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
      self?.tick()
    }
  }

  private func tick() {
    guard isRunning, let started = sessionStartedAt else { return }
    let now = Date()
    let pausedNow = isPaused ? now.timeIntervalSince(pauseBeganAt ?? now) : 0
    let elapsed = max(0, Int(now.timeIntervalSince(started) - pausedAccumSec - pausedNow))
    onMain {
      self.elapsedSec = elapsed
      if self.distanceM > 0.5 {
        self.paceMinPerKm = (Double(elapsed) / 60.0) / (self.distanceM / 1000.0)
      } else {
        self.paceMinPerKm = 0
      }
    }
    updateGuidedLegProgress(now: now)
    sendWatchMetricsIfNeeded()
  }

  private func updateGuidedLegProgress(now: Date) {
    guard !guidedTimeline.isEmpty else {
      onMain {
        self.phaseLabel = self.mode == .run ? "Running" : "Walking"
        self.segmentRemainingSec = 0
      }
      return
    }
    guard currentLegIndex < guidedTimeline.count else {
      onMain {
        self.phaseLabel = "Summary"
        self.segmentRemainingSec = 0
      }
      return
    }
    guard let legStart = legStartedAt else { return }
    let leg = guidedTimeline[currentLegIndex]
    let pausedNow = isPaused ? now.timeIntervalSince(legPauseBeganAt ?? now) : 0
    let elapsed = Int(max(0, now.timeIntervalSince(legStart) - legPausedAccumSec - pausedNow))
    let remaining = max(0, leg.durationSec - elapsed)
    onMain {
      self.segmentRemainingSec = remaining
      self.phaseLabel = leg.label
      self.intervalCurrent = leg.intervalCurrent
      self.intervalTotal = leg.intervalTotal
    }

    if !isPaused && remaining <= 0 {
      currentLegIndex += 1
      legStartedAt = now
      legPausedAccumSec = 0
      legPauseBeganAt = nil
      applyCurrentLegState()
    }
  }

  private func applyCurrentLegState() {
    guard !guidedTimeline.isEmpty else { return }
    guard currentLegIndex < guidedTimeline.count else {
      onMain {
        self.phaseLabel = "Summary"
        self.segmentRemainingSec = 0
      }
      sendWatchEvent(type: "guided_complete")
      playHaptic(.success)
      return
    }
    let leg = guidedTimeline[currentLegIndex]
    legPausedAccumSec = 0
    legPauseBeganAt = nil
    onMain {
      self.phaseLabel = leg.label
      self.segmentRemainingSec = leg.durationSec
      self.intervalCurrent = leg.intervalCurrent
      self.intervalTotal = leg.intervalTotal
    }
    playHaptic(.directionUp)
    sendWatchEvent(type: "guided_transition", extra: [
      "phase": leg.phase,
      "label": leg.label,
      "intervalCurrent": leg.intervalCurrent,
      "intervalTotal": leg.intervalTotal,
      "durationSec": leg.durationSec,
    ])
  }

  private func playHaptic(_ type: WKHapticType) {
    WKInterfaceDevice.current().play(type)
  }

  private func sendWatchMetricsIfNeeded() {
    let now = Date()
    let elapsedChanged = abs(elapsedSec - lastElapsedSent) >= 2
    let distanceChanged = abs(distanceM - lastDistanceSent) >= 5
    let timedOut = now.timeIntervalSince(lastWatchPayloadSentAt) >= 4
    if !(elapsedChanged || distanceChanged || timedOut) {
      return
    }
    lastElapsedSent = elapsedSec
    lastDistanceSent = distanceM
    lastWatchPayloadSentAt = now
    sendWatchEvent(type: "metrics", extra: [
      "elapsedSec": elapsedSec,
      "distanceM": distanceM,
      "heartRate": heartRate,
      "paceMinPerKm": paceMinPerKm,
      "phaseLabel": phaseLabel,
      "segmentRemainingSec": segmentRemainingSec,
      "intervalCurrent": intervalCurrent,
      "intervalTotal": intervalTotal,
      "isPaused": isPaused,
      "mode": mode.rawValue,
    ])
  }

  private func sendWatchEvent(type: String, extra: [String: Any] = [:]) {
    guard WCSession.isSupported() else { return }
    var payload: [String: Any] = ["type": type]
    payload["sentAtMs"] = Int(Date().timeIntervalSince1970 * 1000)
    extra.forEach { payload[$0.key] = $0.value }
    let session = WCSession.default
    if session.isReachable {
      session.sendMessage(payload, replyHandler: nil, errorHandler: nil)
    } else {
      session.transferUserInfo(payload)
      try? session.updateApplicationContext(payload)
    }
  }

  // MARK: - HKWorkoutSessionDelegate

  func workoutSession(_ workoutSession: HKWorkoutSession, didChangeTo toState: HKWorkoutSessionState, from fromState: HKWorkoutSessionState, date: Date) {
    switch toState {
    case .running:
      self.onMain {
        self.isPaused = false
        self.statusText = self.mode == .run ? "Running" : "Walking"
      }
    case .paused:
      self.onMain {
        self.isPaused = true
        self.statusText = "Paused"
      }
    case .ended:
      finishWorkout(at: date)
    default:
      break
    }
  }

  func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
    onMain {
      self.statusText = "Workout error"
      self.isRunning = false
      self.isPaused = false
      self.tickTimer?.invalidate()
      self.tickTimer = nil
    }
  }

  // MARK: - HKLiveWorkoutBuilderDelegate

  func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}

  func workoutBuilder(_ workoutBuilder: HKLiveWorkoutBuilder, didCollectDataOf collectedTypes: Set<HKSampleType>) {
    guard let heartRateType = HKObjectType.quantityType(forIdentifier: .heartRate),
          let distanceType = HKObjectType.quantityType(forIdentifier: .distanceWalkingRunning) else {
      return
    }

    if collectedTypes.contains(heartRateType),
       let stats = workoutBuilder.statistics(for: heartRateType),
       let quantity = stats.mostRecentQuantity() {
      let value = quantity.doubleValue(for: HKUnit.count().unitDivided(by: HKUnit.minute()))
      self.onMain {
        self.heartRate = value
      }
    }

    if collectedTypes.contains(distanceType),
       let stats = workoutBuilder.statistics(for: distanceType),
       let quantity = stats.sumQuantity() {
      let value = quantity.doubleValue(for: HKUnit.meter())
      self.onMain {
        self.distanceM = value
      }
    }
  }

  private func finishWorkout(at endDate: Date) {
    onMain {
      self.tickTimer?.invalidate()
      self.tickTimer = nil
      self.isRunning = false
      self.isPaused = false
      self.pauseBeganAt = nil
    }

    guard let builder = workoutBuilder else {
      self.onMain {
        self.statusText = "Finished"
      }
      return
    }

    builder.endCollection(withEnd: endDate) { [weak self] _, _ in
      builder.finishWorkout { _, _ in
        guard let self else { return }
        self.onMain {
          let summary = WorkoutSummary(
            mode: self.mode,
            durationSec: self.elapsedSec,
            distanceM: self.distanceM,
            paceMinPerKm: self.paceMinPerKm,
            heartRate: self.heartRate,
            endedAt: endDate
          )
          let endedByPhone = self.endingRequestedByPhone
          self.statusText = endedByPhone ? "Saved on phone" : "Finished"
          self.lastSummary = nil
          self.reviewPending = !endedByPhone
          self.reviewFeel = ""
          self.playHaptic(.success)
          self.sendWatchEvent(type: "workout_ended", extra: [
            "elapsedSec": summary.durationSec,
            "distanceM": summary.distanceM,
            "heartRate": summary.heartRate,
            "paceMinPerKm": summary.paceMinPerKm,
            "mode": self.mode.rawValue,
            "source": endedByPhone ? "phone" : "watch",
          ])
          self.elapsedSec = 0
          self.distanceM = 0
          self.heartRate = 0
          self.paceMinPerKm = 0
          self.workoutBuilder = nil
          self.workoutSession = nil
          self.guidedTimeline = []
          self.currentLegIndex = 0
          self.phaseLabel = "Idle"
          self.segmentRemainingSec = 0
          self.intervalCurrent = 0
          self.intervalTotal = 0
          self.countdownSec = 0
          self.endingRequestedByPhone = false
          self.sendWatchEvent(type: "workout_state", extra: self.currentStatePayload())
        }
      }
    }
  }

  // MARK: - WCSessionDelegate

  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    onMain {
      self.watchReachable = session.isReachable
      if let error {
        self.statusText = "Watch link error"
        self.sendWatchEvent(type: "watch_activation_error", extra: ["error": error.localizedDescription])
      } else {
        self.sendWatchEvent(type: "watch_activation", extra: ["state": activationState.rawValue])
      }
    }
  }

  func sessionReachabilityDidChange(_ session: WCSession) {
    onMain {
      self.watchReachable = session.isReachable
    }
  }

  func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
    handleIncomingCommand(message)
  }

  func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    handleIncomingCommand(applicationContext)
  }

  func session(_ session: WCSession, didReceiveUserInfo userInfo: [String : Any] = [:]) {
    handleIncomingCommand(userInfo)
  }

  private func handleIncomingCommand(_ message: [String: Any]) {
    guard let type = message["type"] as? String else { return }
    DispatchQueue.main.async {
      switch type {
      case "ping":
        self.sendWatchEvent(type: "pong", extra: ["ts": Date().timeIntervalSince1970])
      case "start_run":
        if (message["skipCountdown"] as? Bool) == true {
          let startedAt = Self.parseStartDate(message["startedAtEpoch"])
          self.startWorkout(mode: .run, guidedLegs: [], startedAt: startedAt)
        } else {
          self.startSimpleWorkout(mode: .run)
        }
      case "start_walk":
        if (message["skipCountdown"] as? Bool) == true {
          let startedAt = Self.parseStartDate(message["startedAtEpoch"])
          self.startWorkout(mode: .walk, guidedLegs: [], startedAt: startedAt)
        } else {
          self.startSimpleWorkout(mode: .walk)
        }
      case "start_guided":
        if (message["skipCountdown"] as? Bool) == true {
          var legs: [GuidedLeg] = []
          legs.append(GuidedLeg(phase: "warmup", label: "Warm-up", durationSec: 300, intervalCurrent: 0, intervalTotal: 8))
          for idx in 1...8 {
            legs.append(GuidedLeg(phase: "run", label: "Run \(idx)/8", durationSec: 60, intervalCurrent: idx, intervalTotal: 8))
            legs.append(GuidedLeg(phase: "walk", label: "Walk \(idx)/8", durationSec: 90, intervalCurrent: idx, intervalTotal: 8))
          }
          legs.append(GuidedLeg(phase: "cooldown", label: "Cool-down", durationSec: 300, intervalCurrent: 8, intervalTotal: 8))
          let startedAt = Self.parseStartDate(message["startedAtEpoch"])
          self.startWorkout(mode: .run, guidedLegs: legs, startedAt: startedAt)
        } else {
          self.startDefaultGuidedRun()
        }
      case "pause":
        self.pause()
      case "resume":
        self.resume()
      case "end":
        self.endingRequestedByPhone = true
        self.end()
      case "request_state":
        self.sendWatchEvent(type: "workout_state", extra: self.currentStatePayload())
      default:
        break
      }
    }
  }

  private static func parseStartDate(_ raw: Any?) -> Date? {
    if let v = raw as? Double {
      return Date(timeIntervalSince1970: v)
    }
    if let v = raw as? Int {
      return Date(timeIntervalSince1970: Double(v))
    }
    if let v = raw as? NSNumber {
      return Date(timeIntervalSince1970: v.doubleValue)
    }
    return nil
  }
}
