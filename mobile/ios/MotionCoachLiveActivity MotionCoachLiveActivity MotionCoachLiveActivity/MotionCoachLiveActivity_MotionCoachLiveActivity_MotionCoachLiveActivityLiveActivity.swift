//
//  MotionCoachLiveActivity_MotionCoachLiveActivity_MotionCoachLiveActivityLiveActivity.swift
//  MotionCoachLiveActivity MotionCoachLiveActivity MotionCoachLiveActivity
//
//  Created by Michael Buttsworth on 6/3/2026.
//

import ActivityKit
import WidgetKit
import SwiftUI

struct MotionCoachLiveActivity_MotionCoachLiveActivity_MotionCoachLiveActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        // Dynamic stateful properties about your activity go here!
        var emoji: String
    }

    // Fixed non-changing properties about your activity go here!
    var name: String
}

struct MotionCoachLiveActivity_MotionCoachLiveActivity_MotionCoachLiveActivityLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: MotionCoachLiveActivity_MotionCoachLiveActivity_MotionCoachLiveActivityAttributes.self) { context in
            // Lock screen/banner UI goes here
            VStack {
                Text("Hello \(context.state.emoji)")
            }
            .activityBackgroundTint(Color.cyan)
            .activitySystemActionForegroundColor(Color.black)

        } dynamicIsland: { context in
            DynamicIsland {
                // Expanded UI goes here.  Compose the expanded UI through
                // various regions, like leading/trailing/center/bottom
                DynamicIslandExpandedRegion(.leading) {
                    Text("Leading")
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text("Trailing")
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text("Bottom \(context.state.emoji)")
                    // more content
                }
            } compactLeading: {
                Text("L")
            } compactTrailing: {
                Text("T \(context.state.emoji)")
            } minimal: {
                Text(context.state.emoji)
            }
            .widgetURL(URL(string: "http://www.apple.com"))
            .keylineTint(Color.red)
        }
    }
}

extension MotionCoachLiveActivity_MotionCoachLiveActivity_MotionCoachLiveActivityAttributes {
    fileprivate static var preview: MotionCoachLiveActivity_MotionCoachLiveActivity_MotionCoachLiveActivityAttributes {
        MotionCoachLiveActivity_MotionCoachLiveActivity_MotionCoachLiveActivityAttributes(name: "World")
    }
}

extension MotionCoachLiveActivity_MotionCoachLiveActivity_MotionCoachLiveActivityAttributes.ContentState {
    fileprivate static var smiley: MotionCoachLiveActivity_MotionCoachLiveActivity_MotionCoachLiveActivityAttributes.ContentState {
        MotionCoachLiveActivity_MotionCoachLiveActivity_MotionCoachLiveActivityAttributes.ContentState(emoji: "😀")
     }
     
     fileprivate static var starEyes: MotionCoachLiveActivity_MotionCoachLiveActivity_MotionCoachLiveActivityAttributes.ContentState {
         MotionCoachLiveActivity_MotionCoachLiveActivity_MotionCoachLiveActivityAttributes.ContentState(emoji: "🤩")
     }
}

#Preview("Notification", as: .content, using: MotionCoachLiveActivity_MotionCoachLiveActivity_MotionCoachLiveActivityAttributes.preview) {
   MotionCoachLiveActivity_MotionCoachLiveActivity_MotionCoachLiveActivityLiveActivity()
} contentStates: {
    MotionCoachLiveActivity_MotionCoachLiveActivity_MotionCoachLiveActivityAttributes.ContentState.smiley
    MotionCoachLiveActivity_MotionCoachLiveActivity_MotionCoachLiveActivityAttributes.ContentState.starEyes
}
