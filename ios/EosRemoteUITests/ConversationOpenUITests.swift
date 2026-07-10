import XCTest

// Bug-A regression (round 3): opening a conversation must land ON the transcript — content
// visible in the viewport with no scroll nudge. Before the fix, the initial bottom-anchored
// layout raced the async event load and left the viewport past the content (blank until a
// small pull snapped it back). Runs against the already-paired simulator app, like
// DrawerDragUITests; opens the first root row (an orchestrator always exists).
final class ConversationOpenUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testConversationOpensWithVisibleTranscript() throws {
        let app = XCUIApplication()
        app.launch()

        let menu = app.buttons["Menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 20), "Code list chrome should appear")

        // First root row of the sessions list (List = collection view; chips live in a
        // separate horizontal ScrollView, so the first list button IS the first row).
        let firstRow = app.collectionViews.firstMatch.buttons.firstMatch
        XCTAssertTrue(firstRow.waitForExistence(timeout: 10), "agent tree should have rows")
        // Coordinate tap: the drawer's pan gesture layer defeats XCUITest hittability
        // (same reason DrawerDragUITests drive by coordinates).
        firstRow.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()

        let transcript = app.scrollViews["transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 10), "conversation should open")

        // Give the initial page time to load + settle WITHOUT touching the scroll view,
        // then require at least one transcript text inside the visible viewport.
        let window = app.windows.firstMatch
        let deadline = Date().addingTimeInterval(12)
        var visible = false
        while Date() < deadline && !visible {
            let texts = transcript.staticTexts.allElementsBoundByIndex
            visible = texts.contains { t in
                guard t.exists, !t.label.isEmpty else { return false }
                let f = t.frame
                return f.height > 0 && f.intersects(window.frame)
            }
            if !visible { RunLoop.current.run(until: Date().addingTimeInterval(1)) }
        }
        XCTAssertTrue(visible, "transcript must be visible on open without a scroll nudge")
    }
}
