import XCTest
@testable import EosRemoteKit

// BackendModels decode (GET /api/backends/:name/models per contracts BackendModelsResponseSchema)
// + the model sheet's provider-selection rules (ports of backendCaps.js providerChoices /
// runningProviderChoice and the ModelPopover commit rule).
final class BackendModelsTests: XCTestCase {

    // MARK: decode

    func testDecodesContractShape() throws {
        let raw = try XCTUnwrap(JSONValue.parse("""
        { "models": ["deepseek-v4-flash", "deepseek-reasoner"],
          "prices": { "deepseek-v4-flash": { "in": 0.27, "out": 1.1 } },
          "error": "provider returned HTTP 401" }
        """))
        let decoded = try XCTUnwrap(BackendModels(raw: raw))
        XCTAssertEqual(decoded.models, ["deepseek-v4-flash", "deepseek-reasoner"])
        XCTAssertEqual(decoded.error, "provider returned HTTP 401")
    }

    func testDecodeIsFailSoft() throws {
        // Missing models → empty list, no error; non-object → nil (transport-level failure).
        let empty = try XCTUnwrap(JSONValue.parse("{}"))
        XCTAssertEqual(BackendModels(raw: empty), BackendModels(models: []))
        let arr = try XCTUnwrap(JSONValue.parse("[]"))
        XCTAssertNil(BackendModels(raw: arr))
    }

    func testModelIdsFallBackToPinned() {
        XCTAssertEqual(BackendModels(models: ["a", "b"]).modelIds(pinned: "x"), ["a", "b"])
        XCTAssertEqual(BackendModels(models: []).modelIds(pinned: "deepseek-v4-flash"),
                       ["deepseek-v4-flash"])
        XCTAssertEqual(BackendModels(models: []).modelIds(pinned: ""), [])
        XCTAssertEqual(BackendModels(models: []).modelIds(pinned: nil), [])
    }

    // MARK: provider rows (Mac providerChoices — subscription kinds collapse into Claude)

    private let config = UiConfig(
        modelCatalog: [],
        backends: [
            UiBackend(kind: "claude-sdk", label: "Claude", enabled: true, billing: "subscription"),
            UiBackend(kind: "openai", label: "OpenAI", enabled: true, billing: "metered"),
        ],
        backendProfiles: [
            BackendProfile(name: "claude-sdk", kind: "claude-sdk", model: "opus", label: "claude-sdk (opus)"),
            BackendProfile(name: "deepseek", kind: "openai", model: "deepseek-v4-flash",
                           label: "deepseek (deepseek-v4-flash)"),
        ])

    func testProviderProfilesDropSubscriptionKinds() {
        XCTAssertEqual(ModelCatalog.providerProfiles(for: config).map(\.name), ["deepseek"])
        XCTAssertEqual(ModelCatalog.providerProfiles(for: nil), [])
    }

    // MARK: worker's provider (Mac runningProviderChoice)

    func testWorkerProfileResolvesConfiguredApiProfile() {
        XCTAssertEqual(ModelCatalog.workerProfile(named: "deepseek", in: config)?.name, "deepseek")
        // Subscription-kind profile → Claude lane (curated catalog), not a provider list.
        XCTAssertNil(ModelCatalog.workerProfile(named: "claude-sdk", in: config))
        XCTAssertNil(ModelCatalog.workerProfile(named: "gone", in: config))
        XCTAssertNil(ModelCatalog.workerProfile(named: nil, in: config))
        XCTAssertNil(ModelCatalog.workerProfile(named: "deepseek", in: nil))
    }

    // MARK: commit value (family alias on the Claude lane, raw id on a provider lane)

    func testCommitModelBranchesOnLane() {
        let choices = ModelCatalog.baseline
        XCTAssertEqual(ModelCatalog.commitModel(profile: nil, model: "opus-4.8", in: choices), "opus")
        XCTAssertEqual(ModelCatalog.commitModel(profile: nil, model: "gpt-5", in: choices), "gpt-5")
        // A provider id must pass through raw — never rewritten to a family alias, even when it
        // contains a family substring (OpenRouter-style "anthropic/claude-opus-…").
        XCTAssertEqual(ModelCatalog.commitModel(profile: "router", model: "anthropic/claude-opus-4.5",
                                                in: choices),
                       "anthropic/claude-opus-4.5")
        XCTAssertEqual(ModelCatalog.commitModel(profile: "deepseek", model: "deepseek-v4-flash",
                                                in: choices),
                       "deepseek-v4-flash")
    }
}
