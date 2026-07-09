import Foundation

// GET /api/ui-config — the slice the phone consumes (contracts UiConfigResponseSchema): the raw
// model catalog for ModelCatalog.curate, the backend descriptors (subscription-lane gate), and the
// named provider profiles. Decoded leniently over JSONValue like every other daemon shape.

public struct CatalogModel: Sendable, Equatable {
    public let id: String
    public let displayName: String
    public let createdAt: String
    public let maxInputTokens: Int?
    // Supported effort levels. nil = unknown (show all), [] = no effort support (hide).
    public let effortLevels: [String]?

    public init(id: String, displayName: String, createdAt: String,
                maxInputTokens: Int?, effortLevels: [String]?) {
        self.id = id
        self.displayName = displayName
        self.createdAt = createdAt
        self.maxInputTokens = maxInputTokens
        self.effortLevels = effortLevels
    }

    public init?(raw: JSONValue) {
        guard let id = raw["id"]?.stringValue, !id.isEmpty else { return nil }
        self.id = id
        self.displayName = raw["displayName"]?.stringValue ?? ""
        self.createdAt = raw["createdAt"]?.stringValue ?? ""
        self.maxInputTokens = raw["maxInputTokens"]?.intValue
        self.effortLevels = raw["effortLevels"]?.arrayValue.map { $0.compactMap(\.stringValue) }
    }
}

// The UI-facing slice of a provider's BackendDescriptor. The model sheet gates its Claude group on
// `billing == "subscription" && enabled` — data, never kind literals (repo rule).
public struct UiBackend: Sendable, Equatable {
    public let kind: String
    public let label: String
    public let enabled: Bool
    public let billing: String

    public init(kind: String, label: String, enabled: Bool, billing: String) {
        self.kind = kind; self.label = label; self.enabled = enabled; self.billing = billing
    }

    public init?(raw: JSONValue) {
        guard let kind = raw["kind"]?.stringValue else { return nil }
        self.kind = kind
        self.label = raw["label"]?.stringValue ?? kind
        self.enabled = raw["enabled"]?.boolValue ?? false
        self.billing = raw["billing"]?.stringValue ?? "metered"
    }
}

// A configured named provider profile (config.backends) — the Providers group of the model sheet.
public struct BackendProfile: Sendable, Equatable, Identifiable {
    public let name: String
    public let kind: String
    public let model: String
    public let label: String
    public var id: String { name }

    public init(name: String, kind: String, model: String, label: String) {
        self.name = name; self.kind = kind; self.model = model; self.label = label
    }

    public init?(raw: JSONValue) {
        guard let name = raw["name"]?.stringValue else { return nil }
        self.name = name
        self.kind = raw["kind"]?.stringValue ?? ""
        self.model = raw["model"]?.stringValue ?? ""
        self.label = raw["label"]?.stringValue ?? name
    }
}

public struct UiConfig: Sendable, Equatable {
    public let modelCatalog: [CatalogModel]
    public let backends: [UiBackend]
    public let backendProfiles: [BackendProfile]

    public init(modelCatalog: [CatalogModel], backends: [UiBackend], backendProfiles: [BackendProfile]) {
        self.modelCatalog = modelCatalog
        self.backends = backends
        self.backendProfiles = backendProfiles
    }

    public init?(raw: JSONValue) {
        guard case .object = raw else { return nil }
        self.modelCatalog = raw["modelCatalog"]?.arrayValue?.compactMap { CatalogModel(raw: $0) } ?? []
        self.backends = raw["backends"]?.arrayValue?.compactMap { UiBackend(raw: $0) } ?? []
        self.backendProfiles = raw["backendProfiles"]?.arrayValue?.compactMap { BackendProfile(raw: $0) } ?? []
    }

    // C6 group-1 gate: is any subscription-billed backend enabled?
    public var hasSubscriptionBackend: Bool {
        backends.contains { $0.enabled && $0.billing == "subscription" }
    }
}

// A curated picker row (§A4): one entry per Claude family — either from the live catalog or a
// baseline placeholder shown until /api/ui-config arrives.
public struct ModelChoice: Sendable, Equatable, Identifiable {
    public let id: String          // short id, e.g. "opus-4.8"
    public let aliases: [String]   // [family alias, full API id] — aliases[0] is the commit value
    public let displayName: String // "Opus 4.8"
    public let blurb: String       // family sentence for the picker subtitle
    public let ctxTokens: Int?
    public let efforts: [String]?  // nil = unknown → all levels

    // The value committed to spawn / PUT model — the family alias, exactly like the Mac picker.
    public var alias: String { aliases.first ?? id }
    public var ctxLabel: String? { ModelCatalog.formatCtx(ctxTokens) }

    public init(id: String, aliases: [String], displayName: String, blurb: String,
                ctxTokens: Int?, efforts: [String]?) {
        self.id = id
        self.aliases = aliases
        self.displayName = displayName
        self.blurb = blurb
        self.ctxTokens = ctxTokens
        self.efforts = efforts
    }
}

public struct EffortChoice: Sendable, Equatable, Identifiable {
    public let id: String
    public let label: String
    public init(id: String, label: String) { self.id = id; self.label = label }
}

// Port of the Mac's lib/models.js (curateCatalog / EFFORTS / effortChoicesFor), §A4.
public enum ModelCatalog {
    private struct Family { let key: String; let blurb: String }

    // Blurbs map the Mac tags (fastest / balanced / most capable / most powerful) into the
    // reference screenshots' sentence style.
    private static let families: [Family] = [
        Family(key: "haiku",  blurb: "Fastest for quick answers"),
        Family(key: "sonnet", blurb: "Most efficient for everyday tasks"),
        Family(key: "opus",   blurb: "For complex tasks"),
        Family(key: "fable",  blurb: "For your toughest challenges"),
    ]

    public static let defaultModelAlias = "opus"
    public static let defaultEffort = "xhigh"

    // Shown until the live catalog arrives (offline-safe default; spawn falls back daemon-side).
    public static let baseline: [ModelChoice] = [
        ModelChoice(id: "haiku-4.5", aliases: ["haiku"], displayName: "Haiku 4.5",
                    blurb: "Fastest for quick answers", ctxTokens: 200_000, efforts: nil),
        ModelChoice(id: "sonnet-5", aliases: ["sonnet"], displayName: "Sonnet 5",
                    blurb: "Most efficient for everyday tasks", ctxTokens: 1_000_000, efforts: nil),
        ModelChoice(id: "opus-4.8", aliases: ["opus"], displayName: "Opus 4.8",
                    blurb: "For complex tasks", ctxTokens: 1_000_000, efforts: nil),
        ModelChoice(id: "fable-5", aliases: ["fable"], displayName: "Fable 5",
                    blurb: "For your toughest challenges", ctxTokens: 1_000_000, efforts: nil),
    ]

    // Per family: latest `createdAt` id matching "claude-<family>-…" → short id, display name
    // (strip "Claude "), ctx tokens, effort levels. Families with no candidate are skipped.
    public static func curate(catalog: [CatalogModel]) -> [ModelChoice] {
        var out: [ModelChoice] = []
        for family in families {
            let prefix = "claude-\(family.key)-"
            let candidates = catalog.filter { $0.id.hasPrefix(prefix) }
            guard let latest = candidates.max(by: { $0.createdAt < $1.createdAt }) else { continue }
            let version = String(latest.id.dropFirst(prefix.count))
                .replacingOccurrences(of: "-\\d{8}$", with: "", options: .regularExpression)
                .replacingOccurrences(of: "-", with: ".")
            let shortId = "\(family.key)-\(version)"
            let name = latest.displayName
                .replacingOccurrences(of: "^Claude\\s+", with: "", options: .regularExpression)
            let ctx = latest.maxInputTokens.flatMap { $0 > 0 ? $0 : nil }
            out.append(ModelChoice(id: shortId, aliases: [family.key, latest.id],
                                   displayName: name.isEmpty ? shortId : name, blurb: family.blurb,
                                   ctxTokens: ctx, efforts: latest.effortLevels))
        }
        return out
    }

    // The picker rows: curated live catalog when present, baseline otherwise.
    public static func choices(for config: UiConfig?) -> [ModelChoice] {
        let curated = curate(catalog: config?.modelCatalog ?? [])
        return curated.isEmpty ? baseline : curated
    }

    // Port of resolveModel: exact id/alias match first, then family substring ("claude-opus-…").
    public static func resolve(_ raw: String?, in choices: [ModelChoice]) -> ModelChoice? {
        guard let raw, !raw.isEmpty else { return nil }
        if let m = choices.first(where: { $0.id == raw || $0.aliases.contains(raw) }) { return m }
        let lower = raw.lowercased()
        guard let family = families.first(where: { lower.contains($0.key) }) else { return nil }
        return choices.first { $0.id.hasPrefix("\(family.key)-") }
    }

    public static let efforts: [EffortChoice] = [
        EffortChoice(id: "low", label: "Low"),
        EffortChoice(id: "medium", label: "Medium"),
        EffortChoice(id: "high", label: "High"),
        EffortChoice(id: "xhigh", label: "Extra"),
        EffortChoice(id: "max", label: "Max"),
        EffortChoice(id: "ultracode", label: "Ultracode"),
    ]

    private static let effortApiLevels: Set<String> = ["low", "medium", "high", "xhigh", "max"]

    // API levels gated by the model's capability (nil → all, [] → hide). ultracode is a session
    // feature, not an API level — it survives whenever the model supports effort at all.
    public static func effortChoices(for model: ModelChoice?) -> [EffortChoice] {
        guard let gate = model?.efforts else { return efforts }
        if gate.isEmpty { return [] }
        return efforts.filter { !effortApiLevels.contains($0.id) || gate.contains($0.id) }
    }

    static func formatCtx(_ tokens: Int?) -> String? {
        guard let tokens, tokens > 0 else { return nil }
        if tokens >= 1_000_000 {
            let m = Double(tokens) / 1_000_000
            return m == m.rounded() ? "\(Int(m))M" : "\(m)M"
        }
        return "\(Int((Double(tokens) / 1000).rounded()))k"
    }
}
