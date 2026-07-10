import XCTest

// Round 7: the app must reopen exactly as it was closed. Runs against the already-paired
// simulator app (DrawerDragUITests pattern). Drives the operator's repro: select the Running
// chip, open a conversation, kill the app → relaunch must land back IN that conversation, and
// back must pop to the Code list with Running still selected. Screenshots land in /tmp for the
// verification record (the simulator shares the host filesystem).
final class StateRestorationUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func snap(_ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        try? png.write(to: URL(fileURLWithPath: "/tmp/round7-\(name).png"))
    }

    private func chip(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", label + ",")).firstMatch
    }

    func testFilterAndConversationRestoreAcrossRelaunch() throws {
        var app = XCUIApplication()
        // Session 1 starts from a clean slate (whatever an earlier test left open must not
        // leak in); session 2 launches WITHOUT the flag — that relaunch IS the test.
        app.launchArguments = ["-eosResetUIState"]
        app.launch()

        // ── Session 1: set Running, open a conversation, kill.
        let menu = app.buttons["Menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 20), "Code list chrome should appear")

        let running = chip(app, "Running")
        XCTAssertTrue(running.waitForExistence(timeout: 10), "Running chip should exist")
        running.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(running.isSelected, "Running chip should select on tap")

        // First row under Running (the daemon driving this test always has a running root).
        let firstRow = app.collectionViews.firstMatch.buttons.firstMatch
        XCTAssertTrue(firstRow.waitForExistence(timeout: 10), "Running tree should have rows")
        firstRow.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()

        let transcript = app.scrollViews["transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 10), "conversation should open")
        snap("before-kill")

        app.terminate()

        // ── Session 2: relaunch lands directly in the same conversation.
        app = XCUIApplication()
        app.launch()

        let restored = app.scrollViews["transcript"]
        XCTAssertTrue(restored.waitForExistence(timeout: 20),
                      "relaunch must land in the conversation that was open at exit")
        // The Code-list chrome must NOT be the visible surface right now.
        let menuAfter = app.buttons["Menu"]
        XCTAssertFalse(menuAfter.exists && menuAfter.isHittable,
                       "relaunch must not land on the Code list while a conversation was open")
        snap("relaunch-conversation")

        // ── Back pops to the Code list with Running still selected.
        let back = app.buttons["Back"]
        XCTAssertTrue(back.waitForExistence(timeout: 5), "conversation header should have Back")
        back.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()

        XCTAssertTrue(app.buttons["Menu"].waitForExistence(timeout: 10),
                      "back should land on the Code list")
        let runningAfter = chip(app, "Running")
        XCTAssertTrue(runningAfter.waitForExistence(timeout: 5), "Running chip should exist")
        XCTAssertTrue(runningAfter.isSelected, "Running must still be the selected filter")
        snap("back-running-selected")
    }
}
