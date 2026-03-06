import ActivityKit
import WidgetKit
import SwiftUI

struct MotionCoachLiveActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: MotionCoachLiveActivityAttributes.self) { context in
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          Text(context.state.phaseLabel)
            .font(.headline)
          Spacer()
          Text(timerDate(fromEpoch: context.state.segmentEndsAtEpoch), style: .timer)
            .font(.subheadline.monospacedDigit())
        }

        ProgressView(value: min(1, max(0, context.state.progress)))
          .tint(context.state.isPaused ? .orange : .green)

        HStack {
          VStack(alignment: .leading, spacing: 2) {
            Text("Total elapsed")
              .font(.caption)
              .foregroundStyle(.secondary)
            Text(timerDate(fromEpoch: context.state.sessionStartedAtEpoch), style: .timer)
              .font(.subheadline.monospacedDigit())
          }
          Spacer()
          VStack(alignment: .trailing, spacing: 2) {
            Text("Distance")
              .font(.caption)
              .foregroundStyle(.secondary)
            Text(formatDistance(context.state.distanceM))
              .font(.subheadline.monospacedDigit())
          }
        }

        HStack(spacing: 24) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Pace")
              .font(.caption)
              .foregroundStyle(.secondary)
            Text(formatPace(context.state.paceMinPerKm))
              .font(.subheadline.monospacedDigit())
          }
        }
      }
      .padding(12)
      .activityBackgroundTint(Color.black.opacity(0.85))
      .activitySystemActionForegroundColor(.white)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Text(timerDate(fromEpoch: context.state.sessionStartedAtEpoch), style: .timer)
            .font(.caption2.monospacedDigit())
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text(timerDate(fromEpoch: context.state.segmentEndsAtEpoch), style: .timer)
            .font(.caption2.monospacedDigit())
        }
        DynamicIslandExpandedRegion(.bottom) {
          HStack {
            Text(context.state.phaseLabel)
            Spacer()
            Text(formatPace(context.state.paceMinPerKm))
          }
          .font(.caption)
        }
      } compactLeading: {
        Text(shortPhase(context.state.phase, paused: context.state.isPaused))
          .font(.caption2)
      } compactTrailing: {
        Text(formatElapsedCompact(context.state.elapsedSec))
          .font(.caption2.monospacedDigit())
      } minimal: {
        Text("🏃")
      }
      .keylineTint(.green)
    }
  }
}

private func formatElapsed(_ sec: Int) -> String {
  let m = max(0, sec) / 60
  let s = max(0, sec) % 60
  return String(format: "%d:%02d", m, s)
}

private func timerDate(fromEpoch value: Double) -> Date {
  Date(timeIntervalSince1970: value)
}


private func formatElapsedCompact(_ sec: Int) -> String {
  let m = max(0, sec) / 60
  return "\(m)m"
}

private func formatDistance(_ meters: Double) -> String {
  if meters < 1000 { return "\(Int(meters.rounded())) m" }
  return String(format: "%.2f km", meters / 1000)
}

private func formatPace(_ pace: Double) -> String {
  if pace <= 0 || !pace.isFinite { return "-" }
  return String(format: "%.2f min/km", pace)
}

private func shortPhase(_ phase: String, paused: Bool) -> String {
  if paused { return "PAUSE" }
  let p = phase.lowercased()
  if p.contains("run") { return "RUN" }
  if p.contains("walk") { return "WALK" }
  if p.contains("warm") { return "WARM" }
  if p.contains("cool") { return "COOL" }
  return "RUN"
}
