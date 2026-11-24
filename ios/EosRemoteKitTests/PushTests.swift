import XCTest
@testable import EosRemoteKit

final class PushTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let name = "push-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    func testAJoinCarriesTheTokenAndItsServiceOnlyOnceIOSGaveOne() throws {
        let push = PushRegistration(defaults: defaults())
        XCTAssertNil(push.join)
        XCTAssertNil(push.settingsLine)
        push.registered(token: Data([0x0a, 0xff, 0x01]))
        XCTAssertEqual(push.join, PushJoin(token: "0aff01", env: "sandbox"), "a debug build talks to the sandbox")
        XCTAssertEqual(push.state, .registered)

        let plain = try JSONSerialization.jsonObject(with: Connector.joinPayload(room: "r", bearer: "b", push: nil))
        XCTAssertEqual(plain as? [String: String], ["t": "join", "room": "r", "bearer": "b"], "as the released app joins")
        let joined = try JSONSerialization.jsonObject(with: Connector.joinPayload(room: "r", bearer: "b", push: push.join))
        XCTAssertEqual(joined as? [String: String],
                       ["t": "join", "room": "r", "bearer": "b", "apnsToken": "0aff01", "apnsEnv": "sandbox"])
    }

    func testAPhoneThatCannotRegisterSaysSoInSettingsAndSendsNoToken() {
        let push = PushRegistration(defaults: defaults())
        push.registered(token: Data([1]))
        push.failed()
        XCTAssertNil(push.join)
        XCTAssertEqual(push.settingsLine, "Push needs the TestFlight app")
        push.denied()
        XCTAssertEqual(push.settingsLine, "Notifications are off for Eos in iOS Settings")
    }

    func testAPushOpensNeedsYouOfTheMacItsMarkNames() {
        let a = Device(id: "dev-a", label: "A", relayUrl: "wss://r/", room: "room-a", bearer: nil)
        let b = Device(id: "dev-b", label: "B", relayUrl: "wss://r/", room: "room-b", bearer: nil)
        // The relay's mark (relay/push/apns.ts): sha256("room-b") in hex, first 8 characters.
        let mark = PushRouting.mark(room: "room-b")
        XCTAssertEqual(mark, "f84b9685")
        XCTAssertEqual(PushRouting.device(for: mark, in: [a, b])?.id, "dev-b")
        XCTAssertEqual(PushRouting.device(for: mark.uppercased(), in: [a, b])?.id, "dev-b")
        XCTAssertNil(PushRouting.device(for: "00000000", in: [a, b]))
        XCTAssertNil(PushRouting.device(for: nil, in: [a, b]))
        XCTAssertEqual(PushRouting.link(for: ["m": mark], in: [a, b])?.absoluteString, "eos://inbox?device=dev-b")
        XCTAssertEqual(PushRouting.link(for: [:], in: [a, b])?.absoluteString, "eos://inbox", "an unknown Mac: the current one")
    }
}
