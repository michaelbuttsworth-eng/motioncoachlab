//
//  ContentView.swift
//  MotionCoachWatchApp Watch App
//
//  Created by Michael Buttsworth on 7/3/2026.
//

import SwiftUI

struct ContentView: View {
    @StateObject private var manager = WorkoutManager()
    private let coral = Color(red: 0.98, green: 0.45, blue: 0.43)
    private let cyan = Color(red: 0.24, green: 0.82, blue: 0.90)

    private func formatDuration(_ sec: Int) -> String {
        let minutes = sec / 60
        let seconds = sec % 60
        return String(format: "%02d:%02d", minutes, seconds)
    }

    private func formatDistance(_ meters: Double) -> String {
        if meters >= 1000 {
            return String(format: "%.2f km", meters / 1000.0)
        }
        return String(format: "%.0f m", meters)
    }

    private func formatPace(_ paceMinPerKm: Double) -> String {
        guard paceMinPerKm > 0 else { return "--" }
        let totalSec = Int((paceMinPerKm * 60.0).rounded())
        let min = totalSec / 60
        let sec = totalSec % 60
        return String(format: "%d:%02d\"/km", min, sec)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("Motion Coach")
                        .font(.headline)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    Spacer()
                    Circle()
                        .fill(manager.watchReachable ? Color.green : Color.gray)
                        .frame(width: 8, height: 8)
                }

                Text(
                    manager.countdownSec > 0
                    ? "\(manager.countdownSec)"
                    : (manager.intervalTotal > 0 && manager.segmentRemainingSec > 0
                       ? formatDuration(manager.segmentRemainingSec)
                       : formatDuration(manager.elapsedSec))
                )
                    .font(.system(size: 32, weight: .bold, design: .rounded))
                    .frame(maxWidth: .infinity, alignment: .center)

                if !["Running", "Walking", "Idle", "Ready", "Paused", "Finished"].contains(manager.phaseLabel) {
                    Text(manager.phaseLabel)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                }

                HStack(spacing: 6) {
                    metricColumn(title: "Dist", value: formatDistance(manager.distanceM), alignment: .leading)
                    metricColumn(title: "Pace", value: formatPace(manager.paceMinPerKm), alignment: .center)
                    metricColumn(
                        title: "Heart",
                        value: manager.heartRate > 0 ? "\(Int(manager.heartRate.rounded())) bpm" : "--",
                        alignment: .trailing
                    )
                }
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.top, 1)

                if manager.reviewPending {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("How did it feel?")
                            .font(.caption.bold())
                            .foregroundStyle(.secondary)
                        HStack(spacing: 6) {
                            ForEach(["😄", "🙂", "😐", "😮", "🥵"], id: \.self) { emoji in
                                Button(emoji) {
                                    manager.selectReviewFeel(emoji)
                                }
                                .buttonStyle(WatchActionButtonStyle(
                                    background: manager.reviewFeel == emoji ? cyan.opacity(0.35) : Color.white.opacity(0.12),
                                    foreground: .white
                                ))
                            }
                        }
                        HStack(spacing: 8) {
                            Button("Discard") {
                                manager.discardReview()
                            }
                            .buttonStyle(WatchActionButtonStyle(background: Color.white.opacity(0.16), foreground: .white))
                            Button("Save") {
                                manager.saveReview()
                            }
                            .buttonStyle(WatchActionButtonStyle(background: cyan, foreground: .black))
                        }
                    }
                    .padding(8)
                    .background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                if manager.intervalTotal > 0 {
                    Text("Interval \(manager.intervalCurrent)/\(manager.intervalTotal)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                }

                if !manager.authorized {
                    Button("Enable Health Access") {
                        manager.requestAuthorization()
                    }
                    .buttonStyle(.borderedProminent)
                }

                if !manager.isRunning && !manager.reviewPending {
                    Button("Start Run") {
                        manager.startSimpleWorkout(mode: .run)
                    }
                    .buttonStyle(WatchActionButtonStyle(background: cyan, foreground: .black))
                    .disabled(manager.countdownSec > 0)

                    Button("Start Walk") {
                        manager.startSimpleWorkout(mode: .walk)
                    }
                    .buttonStyle(WatchActionButtonStyle(background: Color.white.opacity(0.20), foreground: .white))
                    .disabled(manager.countdownSec > 0)

                    Button("Guided C25K") {
                        manager.startDefaultGuidedRun()
                    }
                    .buttonStyle(WatchActionButtonStyle(background: coral, foreground: .white))
                    .disabled(manager.countdownSec > 0)
                } else {
                    if manager.isPaused {
                        Button("Resume") {
                            manager.resume()
                        }
                        .buttonStyle(WatchActionButtonStyle(background: cyan, foreground: .black))
                    } else {
                        Button("Pause") {
                            manager.pause()
                        }
                        .buttonStyle(WatchActionButtonStyle(background: Color.white.opacity(0.20), foreground: .white))
                    }
                    Button("End Workout", role: .destructive) {
                        manager.endFromWatch()
                    }
                    .buttonStyle(WatchActionButtonStyle(background: coral.opacity(0.92), foreground: .white))
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
        .onAppear {
            manager.requestAuthorization()
            manager.requestPhoneStateSync()
        }
    }
}

private struct WatchActionButtonStyle: ButtonStyle {
    let background: Color
    let foreground: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .foregroundStyle(foreground.opacity(configuration.isPressed ? 0.8 : 1))
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(background.opacity(configuration.isPressed ? 0.75 : 1))
            )
    }
}

private extension ContentView {
    @ViewBuilder
    func metricColumn(title: String, value: String, alignment: HorizontalAlignment) -> some View {
        VStack(alignment: alignment, spacing: 2) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.footnote.bold())
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.62)
        }
        .frame(maxWidth: .infinity, alignment: frameAlignment(alignment))
    }

    func frameAlignment(_ alignment: HorizontalAlignment) -> Alignment {
        switch alignment {
        case .leading:
            return .leading
        case .trailing:
            return .trailing
        default:
            return .center
        }
    }
}

#Preview {
    ContentView()
}
