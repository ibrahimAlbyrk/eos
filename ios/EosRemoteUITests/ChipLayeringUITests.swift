import XCTest

// Round-8 probe: exercises the Code-list gestures the operator reported (press chips, pull the
// list down/up) while an external `simctl io recordVideo` captures frames — the artifact is a
// mid-drag layering glitch between the offline pill, the filter chips, and the list content.
final class ChipLayeringUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testProbeGestures() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-eosResetUIState"]
        app.launch()

        let menu = app.buttons["Menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 20), "Code list chrome should appear")
        sleep(3)   // let the connection attempt fail → "Not connected — pull to retry"

        let win = app.windows.firstMatch
        func c(_ x: CGFloat, _ y: CGFloat) -> XCUICoordinate {
            win.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y))
        }

        // 1. Tap each chip (coordinate taps — drawer pan layer defeats hittability).
        let chips = app.buttons["Archived"]
        _ = chips.waitForExistence(timeout: 5)
        for name in ["Archived", "Running", "All"] {
            let chip = app.buttons[name]
            if chip.exists { chip.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
            usleep(600_000)
        }

        // 2. Pull-to-refresh: slow drag down starting on the list, hold mid-drag.
        c(0.5, 0.35).press(forDuration: 0.2, thenDragTo: c(0.5, 0.80),
                           withVelocity: .slow, thenHoldForDuration: 2.0)
        sleep(2)

        // 3. Drag DOWN starting on the chip row itself.
        c(0.5, 0.165).press(forDuration: 0.2, thenDragTo: c(0.5, 0.60),
                            withVelocity: .slow, thenHoldForDuration: 2.0)
        sleep(1)

        // 4. Drag UP starting low on the list (scroll content up past the chips).
        c(0.5, 0.70).press(forDuration: 0.2, thenDragTo: c(0.5, 0.15),
                           withVelocity: .slow, thenHoldForDuration: 2.0)
        sleep(1)

        // 5. Horizontal wiggle on the chip row (it is a ScrollView — bounce it).
        c(0.3, 0.165).press(forDuration: 0.2, thenDragTo: c(0.9, 0.165),
                            withVelocity: .slow, thenHoldForDuration: 1.0)
        sleep(2)
    }
}
