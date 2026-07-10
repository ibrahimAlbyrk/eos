import XCTest

// Drawer drag physics (round-2 item 1): the content panel must track horizontal pans in both
// directions and spring to the nearest state on release. Runs against the already-paired
// simulator app; the Code list must be the root when the app launches.
final class DrawerDragUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testDrawerDragOpenReleaseAndClose() throws {
        let app = XCUIApplication()
        app.launch()

        // Root chrome up (Menu = the hamburger; hidden from accessibility while the drawer is open).
        let menu = app.buttons["Menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 20), "Code list chrome should appear")
        let window = app.windows.firstMatch
        let newSession = app.buttons["New agent"]

        // 1) Partial rightward pan (to ~40% of the drawer width), hold, release: the panel must
        //    track the finger while held (screenshot taken mid-hold by the harness) and spring
        //    BACK CLOSED on release — below half, no velocity.
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.55))
            .press(forDuration: 0.05,
                   thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.55)),
                   withVelocity: 200, thenHoldForDuration: 2.5)
        XCTAssertTrue(menu.waitForExistence(timeout: 3),
                      "sub-half release with no velocity must spring back closed")
        XCTAssertFalse(newSession.exists && newSession.isHittable,
                       "drawer must not be open after a sub-half release")

        // 2) Full rightward pan from mid-content (NOT the 24pt edge gutter) → opens.
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.55))
            .press(forDuration: 0.05,
                   thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.55)),
                   withVelocity: 500, thenHoldForDuration: 0.1)
        XCTAssertTrue(newSession.waitForExistence(timeout: 3),
                      "rightward pan from mid-content should open the drawer")

        // 3) Leftward pan starting on the exposed content panel → closes.
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.55))
            .press(forDuration: 0.05,
                   thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.55)),
                   withVelocity: 500, thenHoldForDuration: 0.1)
        XCTAssertTrue(menu.waitForExistence(timeout: 3),
                      "leftward pan on the content panel should close the drawer")
    }
}
