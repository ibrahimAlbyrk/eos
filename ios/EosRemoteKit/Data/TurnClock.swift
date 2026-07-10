import Foundation

// Server-relative turn clock (round 5, item D). The Mac dashboard's elapsed timer
// is `now - worker.turn_started_at` against the DAEMON's clock (app/ui
// agentActivity.js) — turn_started_at is stamped by core TransitionState on every
// entry into the busy set. The phone can't trust its own wall clock against that
// epoch (skew), so it estimates the daemon clock from the `ts` the daemon stamps
// on every event frame: offset = deviceNow - serverTs at receipt. Network latency
// biases the estimate late by one hop — sub-second, irrelevant at M:SS grain.
public struct TurnClock: Sendable, Equatable {
    public private(set) var offsetMs: Double = 0
    public private(set) var hasSample = false

    public init() {}

    public mutating func sample(serverTsMs: Double, deviceNowMs: Double) {
        offsetMs = deviceNowMs - serverTsMs
        hasSample = true
    }

    // Elapsed against the estimated server clock; clamped so a stamp "in the
    // future" (offset not yet sampled + fast phone clock) never renders negative.
    public func elapsedMs(turnStartedAt: Double, deviceNowMs: Double) -> Double {
        max(0, deviceNowMs - offsetMs - turnStartedAt)
    }
}
