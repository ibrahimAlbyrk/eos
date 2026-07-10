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
        // Round 7 restores the previously open conversation on launch — reset so this
        // test starts from the Code-list root it assumes.
        app.launchArguments += ["-eosResetUIState"]
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

    // Round-6 regression gate (round-4 finding): XCUITest snapshot queries must stay fast on a LONG
    // transcript. Before the accessibility flattening, every tool row exposed 5-7 elements and every
    // diff line 3, so a deep transcript ballooned the AX tree until snapshot queries timed out
    // (~15s+), killing conversation-flow tests. Opens the first root row, pages a chunk of history in
    // by swiping toward the top (materializes more LazyVStack rows and fires the older-page loader),
    // then requires two representative queries to resolve inside a hard budget.
    func testLongTranscriptQueriesStayFast() throws {
        let app = XCUIApplication()
        // Round 7 restores the previously open conversation on launch — reset so this
        // test starts from the Code-list root it assumes.
        app.launchArguments += ["-eosResetUIState"]
        app.launch()

        let menu = app.buttons["Menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 20), "Code list chrome should appear")
        let firstRow = app.collectionViews.firstMatch.buttons.firstMatch
        XCTAssertTrue(firstRow.waitForExistence(timeout: 10), "agent tree should have rows")
        firstRow.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()

        let transcript = app.scrollViews["transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 10), "conversation should open")
        RunLoop.current.run(until: Date().addingTimeInterval(2))   // let the initial page land

        // Pull older history into the tree: each swipe materializes rows above the viewport; near the
        // top the backward pager prepends another page — the worst realistic tree this device can show.
        for _ in 0..<8 {
            transcript.swipeDown()
            RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        }

        let t0 = Date()
        let staticTextCount = transcript.staticTexts.allElementsBoundByIndex.count
        let staticTextSecs = Date().timeIntervalSince(t0)

        let t1 = Date()
        let anyCount = app.descendants(matching: .any).count
        let anySecs = Date().timeIntervalSince(t1)

        print("[a11y-budget] staticTexts=\(staticTextCount) in \(String(format: "%.2f", staticTextSecs))s; " +
              "descendants=\(anyCount) in \(String(format: "%.2f", anySecs))s")

        XCTAssertGreaterThan(staticTextCount, 0, "long transcript should expose text content")
        XCTAssertLessThan(staticTextSecs, 10, "staticTexts query must resolve well under the snapshot timeout")
        XCTAssertLessThan(anySecs, 15, "full-tree query must not hit the snapshot timeout")
    }
}
