import XCTest
@testable import EosRemoteKit

// Timer-source derivation (round 5, item D): elapsed must equal serverNow -
// turn_started_at regardless of the phone's wall-clock skew, so the iOS thinking
// timer shows the SAME duration as the Mac dashboard (agentActivity.js).
final class TurnClockTests: XCTestCase {

    func testElapsedMatchesServerClockWhenPhoneRunsAhead() {
        var clock = TurnClock()
        // Server says 1_000_000; the phone's clock is 5 minutes ahead.
        let skew: Double = 5 * 60 * 1000
        clock.sample(serverTsMs: 1_000_000, deviceNowMs: 1_000_000 + skew)
        XCTAssertTrue(clock.hasSample)
        // 42s later on both clocks, a turn that started at server 990_000.
        let elapsed = clock.elapsedMs(turnStartedAt: 990_000, deviceNowMs: 1_042_000 + skew)
        XCTAssertEqual(elapsed, 52_000, "elapsed = serverNow(1_042_000) - start(990_000), skew cancelled")
    }

    func testElapsedMatchesServerClockWhenPhoneRunsBehind() {
        var clock = TurnClock()
        clock.sample(serverTsMs: 2_000_000, deviceNowMs: 2_000_000 - 30_000)
        let elapsed = clock.elapsedMs(turnStartedAt: 1_900_000, deviceNowMs: 2_060_000 - 30_000)
        XCTAssertEqual(elapsed, 160_000)
    }

    func testNeverNegative() {
        var clock = TurnClock()
        clock.sample(serverTsMs: 1_000, deviceNowMs: 1_000)
        // A turn stamped "in the future" relative to the estimate must clamp to 0.
        XCTAssertEqual(clock.elapsedMs(turnStartedAt: 5_000, deviceNowMs: 2_000), 0)
    }

    func testUnsampledClockFallsBackToRawDeviceClock() {
        let clock = TurnClock()
        XCTAssertFalse(clock.hasSample)
        XCTAssertEqual(clock.elapsedMs(turnStartedAt: 1_000, deviceNowMs: 61_000), 60_000,
                       "offset 0 until the first event frame — raw epoch math still beats a reset-to-zero timer")
    }

    func testResampleTracksLatestOffset() {
        var clock = TurnClock()
        clock.sample(serverTsMs: 1_000, deviceNowMs: 2_000)
        XCTAssertEqual(clock.offsetMs, 1_000)
        clock.sample(serverTsMs: 10_000, deviceNowMs: 10_500)
        XCTAssertEqual(clock.offsetMs, 500, "each event frame refreshes the estimate")
    }
}
