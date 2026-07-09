import XCTest
@testable import EosRemoteKit

// UiConfig decode (GET /api/ui-config per contracts UiConfigResponseSchema) + the ModelCatalog
// curate/effort ports of the Mac's lib/models.js (§A4).
final class UiConfigTests: XCTestCase {

    private let sampleJSON = """
    {
      "models": ["claude-opus-4-8-20260115"],
      "modelCatalog": [
        { "id": "claude-opus-4-8-20260115", "displayName": "Claude Opus 4.8",
          "createdAt": "2026-01-15T00:00:00Z", "maxInputTokens": 1000000, "maxTokens": 64000,
          "effortLevels": ["low", "medium", "high", "xhigh", "max"] },
        { "id": "claude-opus-4-6-20250901", "displayName": "Claude Opus 4.6",
          "createdAt": "2025-09-01T00:00:00Z", "maxInputTokens": 200000, "maxTokens": 64000,
          "effortLevels": null },
        { "id": "claude-haiku-4-5-20251001", "displayName": "Claude Haiku 4.5",
          "createdAt": "2025-10-01T00:00:00Z", "maxInputTokens": 200000, "maxTokens": 64000,
          "effortLevels": [] }
      ],
      "prices": {},
      "permissions": { "defaultTtlMs": 60000 },
      "sse": { "keepaliveMs": 15000 },
      "backends": [
        { "kind": "claude-sdk", "label": "Claude", "enabled": true, "billing": "subscription",
          "sessionStore": "claude-transcript",
          "capabilities": { "interrupt": true, "keystroke": false, "rewind": false,
                            "runtimeModelSwitch": true, "runtimePermissionSwitch": true } },
        { "kind": "openai", "label": "OpenAI", "enabled": false, "billing": "metered",
          "sessionStore": "eos-conversation", "wireDialect": "openai-chat",
          "capabilities": { "interrupt": true, "keystroke": false, "rewind": false,
                            "runtimeModelSwitch": false, "runtimePermissionSwitch": false } }
      ],
      "backendProfiles": [
        { "name": "gpt", "kind": "openai", "model": "gpt-5", "label": "GPT-5" }
      ]
    }
    """

    private func decodeSample() -> UiConfig? {
        JSONValue.parse(sampleJSON).flatMap { UiConfig(raw: $0) }
    }

    // MARK: decode

    func testDecodesContractShape() throws {
        let config = try XCTUnwrap(decodeSample())
        XCTAssertEqual(config.modelCatalog.count, 3)

        let opus = config.modelCatalog[0]
        XCTAssertEqual(opus.id, "claude-opus-4-8-20260115")
        XCTAssertEqual(opus.displayName, "Claude Opus 4.8")
        XCTAssertEqual(opus.maxInputTokens, 1_000_000)
        XCTAssertEqual(opus.effortLevels, ["low", "medium", "high", "xhigh", "max"])

        // effortLevels: null → nil (unknown), [] → empty (no effort support) — distinct states.
        XCTAssertNil(config.modelCatalog[1].effortLevels)
        XCTAssertEqual(config.modelCatalog[2].effortLevels, [])

        XCTAssertEqual(config.backends.count, 2)
        XCTAssertEqual(config.backends[0].kind, "claude-sdk")
        XCTAssertTrue(config.backends[0].enabled)
        XCTAssertEqual(config.backends[0].billing, "subscription")
        XCTAssertTrue(config.hasSubscriptionBackend)

        XCTAssertEqual(config.backendProfiles, [
            BackendProfile(name: "gpt", kind: "openai", model: "gpt-5", label: "GPT-5"),
        ])
    }

    func testNoSubscriptionWhenDisabled() throws {
        let raw = try XCTUnwrap(JSONValue.parse("""
        { "modelCatalog": [], "backends": [
          { "kind": "claude-sdk", "label": "Claude", "enabled": false, "billing": "subscription" }
        ], "backendProfiles": [] }
        """))
        let config = try XCTUnwrap(UiConfig(raw: raw))
        XCTAssertFalse(config.hasSubscriptionBackend)
    }

    // MARK: curate (§A4)

    func testCuratePicksLatestPerFamilyAndDerivesShortId() throws {
        let config = try XCTUnwrap(decodeSample())
        let curated = ModelCatalog.curate(catalog: config.modelCatalog)

        // Families in fixed order (haiku, sonnet, opus, fable); sonnet/fable have no candidates.
        XCTAssertEqual(curated.map(\.id), ["haiku-4.5", "opus-4.8"])

        let opus = curated[1]
        // Latest createdAt wins (4.8 over 4.6); date suffix stripped, dashes → dots.
        XCTAssertEqual(opus.aliases, ["opus", "claude-opus-4-8-20260115"])
        XCTAssertEqual(opus.alias, "opus")                    // the commit value
        XCTAssertEqual(opus.displayName, "Opus 4.8")          // "Claude " stripped
        XCTAssertEqual(opus.ctxLabel, "1M")
        XCTAssertEqual(opus.efforts, ["low", "medium", "high", "xhigh", "max"])

        let haiku = curated[0]
        XCTAssertEqual(haiku.ctxLabel, "200k")
        XCTAssertEqual(haiku.efforts, [])
    }

    func testCurateSingleDigitVersion() {
        let curated = ModelCatalog.curate(catalog: [
            CatalogModel(id: "claude-fable-5-20260301", displayName: "Claude Fable 5",
                         createdAt: "2026-03-01T00:00:00Z", maxInputTokens: 1_000_000, effortLevels: nil),
        ])
        XCTAssertEqual(curated.map(\.id), ["fable-5"])
        XCTAssertEqual(curated[0].displayName, "Fable 5")
    }

    func testCurateEmptyCatalog() {
        XCTAssertEqual(ModelCatalog.curate(catalog: []), [])
    }

    // MARK: baseline + choices

    func testChoicesFallBackToBaselineUntilConfigArrives() {
        XCTAssertEqual(ModelCatalog.choices(for: nil), ModelCatalog.baseline)
        XCTAssertEqual(ModelCatalog.baseline.map(\.alias), ["haiku", "sonnet", "opus", "fable"])
        XCTAssertEqual(ModelCatalog.defaultModelAlias, "opus")
        XCTAssertEqual(ModelCatalog.defaultEffort, "xhigh")
    }

    func testResolveByAliasIdAndFamilySubstring() {
        let baseline = ModelCatalog.baseline
        XCTAssertEqual(ModelCatalog.resolve("opus", in: baseline)?.id, "opus-4.8")
        XCTAssertEqual(ModelCatalog.resolve("fable-5", in: baseline)?.id, "fable-5")
        XCTAssertEqual(ModelCatalog.resolve("claude-fable-5-20260301", in: baseline)?.id, "fable-5")
        XCTAssertNil(ModelCatalog.resolve("gpt-5", in: baseline))
        XCTAssertNil(ModelCatalog.resolve(nil, in: baseline))
    }

    // MARK: effort gating (§A4)

    func testEffortChoicesUnknownShowsAll() {
        let model = ModelChoice(id: "opus-4.8", aliases: ["opus"], displayName: "Opus 4.8",
                                blurb: "", ctxTokens: nil, efforts: nil)
        XCTAssertEqual(ModelCatalog.effortChoices(for: model).map(\.id),
                       ["low", "medium", "high", "xhigh", "max", "ultracode"])
        XCTAssertEqual(ModelCatalog.effortChoices(for: nil).count, 6)
    }

    func testEffortChoicesEmptyHidesSection() {
        let model = ModelChoice(id: "haiku-4.5", aliases: ["haiku"], displayName: "Haiku 4.5",
                                blurb: "", ctxTokens: nil, efforts: [])
        XCTAssertEqual(ModelCatalog.effortChoices(for: model), [])
    }

    func testEffortChoicesGateApiLevelsButKeepUltracode() {
        let model = ModelChoice(id: "opus-4.8", aliases: ["opus"], displayName: "Opus 4.8",
                                blurb: "", ctxTokens: nil, efforts: ["high", "max"])
        XCTAssertEqual(ModelCatalog.effortChoices(for: model).map(\.id), ["high", "max", "ultracode"])
    }

    func testEffortLabels() {
        XCTAssertEqual(ModelCatalog.efforts.map(\.label),
                       ["Low", "Medium", "High", "Extra", "Max", "Ultracode"])
    }
}
