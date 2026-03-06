import ActivityKit

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
