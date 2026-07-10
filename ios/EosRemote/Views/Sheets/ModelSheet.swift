import SwiftUI
import EosRemoteKit

// Who is committing a model/effort pick (contract §H P5). Draft = NewSessionView's pre-spawn
// bindings; worker = the conversation's three-dot "Change model", committed via
// PUT /workers/:id/model. The Providers group only exists in draft context (runtime provider
// switch is a later capability question, §C6).
enum ModelSheetContext {
    case draft(model: Binding<String>, effort: Binding<String>, backendProfile: Binding<String?>)
    case worker(Worker)
}

// Model + effort sheet (contract §C6, ref IMG_4424): NavigationStack-in-sheet, page 1 = the
// selected provider's models (+ the provider selector in draft context) with the pinned Effort
// row, page 2 = the per-model effort list. The Claude lane renders the curated families from
// ModelCatalog over /api/ui-config; a configured provider profile renders its own model list via
// GET /api/backends/:name/models (Mac two-level picker, contract G4), cached per provider for the
// sheet's lifetime and fail-soft to the profile's pinned model. A worker running on a profile
// browses that provider's list too (Mac runningProviderChoice). Selection commits immediately;
// the sheet stays open until X (ref behavior).
struct ModelSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    private let context: ModelSheetContext
    // Local mirror of the committed values so checkmarks flip instantly in both contexts.
    @State private var currentModel: String
    @State private var currentEffort: String
    @State private var currentProfile: String?
    @State private var showEffort = false
    @State private var fetching = false
    @State private var fetchFailed = false
    // Per-provider model lists (GET /api/backends/:name/models), cached for the sheet's lifetime.
    @State private var providerModels: [String: BackendModels] = [:]
    @State private var loadingProviders: Set<String> = []
    // The Claude-lane pick to restore when switching back from a provider profile.
    @State private var lastClaudeModel: String?

    init(context: ModelSheetContext) {
        self.context = context
        switch context {
        case .draft(let m, let e, let bp):
            _currentModel = State(initialValue: m.wrappedValue)
            _currentEffort = State(initialValue: e.wrappedValue)
            _currentProfile = State(initialValue: bp.wrappedValue)
        case .worker(let w):
            _currentModel = State(initialValue: w.model ?? ModelCatalog.defaultModelAlias)
            _currentEffort = State(initialValue: w.effort ?? ModelCatalog.defaultEffort)
            _currentProfile = State(initialValue: nil)
        }
    }

    private var isWorkerContext: Bool { if case .worker = context { return true }; return false }

    // C6 group 1: curated live catalog behind the subscription gate; baseline families otherwise
    // (spawn falls back daemon-side, so the offline default stays honest).
    private var claudeChoices: [ModelChoice] {
        guard let cfg = model.uiConfig, cfg.hasSubscriptionBackend else { return ModelCatalog.baseline }
        return ModelCatalog.choices(for: cfg)
    }

    private var profiles: [BackendProfile] {
        isWorkerContext ? [] : ModelCatalog.providerProfiles(for: model.uiConfig)
    }

    // The provider whose models page 1 lists: the draft's picked profile, or a running worker's
    // own configured profile (its models aren't the Claude catalog). nil = the Claude lane.
    private var activeProfile: BackendProfile? {
        switch context {
        case .draft:
            return currentProfile.flatMap { name in profiles.first { $0.name == name } }
        case .worker(let w):
            return ModelCatalog.workerProfile(named: w.raw["backend_profile"]?.stringValue,
                                              in: model.uiConfig)
        }
    }

    private var resolvedChoice: ModelChoice? { ModelCatalog.resolve(currentModel, in: claudeChoices) }

    // Mac effortChoicesFor rule: gate on whatever the curated catalog resolves the current model
    // to — a provider id it can't resolve means unknown effort support, so all levels show.
    private var effortChoices: [EffortChoice] { ModelCatalog.effortChoices(for: resolvedChoice) }

    var body: some View {
        NavigationStack {
            modelsPage
                .navigationBarBackButtonHidden(true)
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(isPresented: $showEffort) {
                    effortPage
                        .navigationBarBackButtonHidden(true)
                        .toolbar(.hidden, for: .navigationBar)
                }
        }
        .eosSheet(detents: [.medium, .large])
        .task {
            if model.uiConfig == nil {
                fetching = true
                fetchFailed = await model.fetchUiConfig() == nil
                fetching = false
            }
            if let p = activeProfile { loadModels(for: p) }
        }
    }

    // MARK: page 1 — models

    private var modelsPage: some View {
        VStack(spacing: 0) {
            EosSheetHeader("Select model") { dismiss() }
            ScrollView {
                VStack(alignment: .leading, spacing: EosSpacing.xs) {
                    if !profiles.isEmpty || activeProfile != nil {
                        SectionCaption(activeProfile?.name ?? "Claude")
                    }
                    if let p = activeProfile {
                        providerModelsCard(p)
                    } else {
                        groupCard {
                            ForEach(claudeChoices) { choice in
                                SelectRow(title: choice.displayName,
                                          subtitle: subtitle(for: choice),
                                          selected: resolvedChoice?.id == choice.id) {
                                    pickModel(choice)
                                }
                            }
                        }
                    }
                    if !profiles.isEmpty {
                        SectionCaption("Providers")
                        groupCard {
                            SelectRow(title: "Claude", subtitle: "Subscription",
                                      selected: activeProfile == nil) {
                                pickClaude()
                            }
                            ForEach(profiles) { p in
                                SelectRow(title: p.name,
                                          subtitle: "\(p.kind) · \(p.model)",
                                          selected: activeProfile?.name == p.name) {
                                    pickProfile(p)
                                }
                            }
                        }
                    }
                    if fetching {
                        ProgressView()
                            .tint(EosColor.inkTertiary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, EosSpacing.sm)
                    } else if fetchFailed {
                        caption("showing defaults")
                    }
                }
                .padding(.horizontal, EosSpacing.screenInset)
            }
            if !effortChoices.isEmpty { effortRow }
        }
        .background(EosColor.surface)
    }

    // The selected provider's own model list (Mac SpawnModelPopover): spinner while the fetch is
    // in flight, then the fetched ids — fail-soft to the profile's pinned model with a quiet
    // error caption when the provider list couldn't be loaded.
    @ViewBuilder
    private func providerModelsCard(_ p: BackendProfile) -> some View {
        let entry = providerModels[p.name]
        if entry == nil, loadingProviders.contains(p.name) {
            groupCard {
                ProgressView()
                    .tint(EosColor.inkTertiary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, EosSpacing.md)
            }
        } else {
            let rows = (entry ?? BackendModels(models: [])).modelIds(pinned: p.model)
            if rows.isEmpty {
                caption("no models")
            } else {
                groupCard {
                    ForEach(rows, id: \.self) { id in
                        SelectRow(title: id, selected: currentModel == id) {
                            pickProviderModel(id)
                        }
                    }
                }
            }
            if let error = entry?.error { caption(error) }
        }
    }

    private func groupCard<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0, content: content)
            .background(EosColor.surface2,
                        in: RoundedRectangle(cornerRadius: EosRadius.card, style: .continuous))
    }

    private func caption(_ text: String) -> some View {
        Text(text)
            .font(EosFont.captionSmall)
            .foregroundStyle(EosColor.inkTertiary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, EosSpacing.xs)
    }

    private func subtitle(for choice: ModelChoice) -> String {
        choice.ctxLabel.map { "\(choice.blurb) · \($0)" } ?? choice.blurb
    }

    // The pinned Effort row (ref IMG_4424 bottom card) — pushes page 2. Hidden when the model
    // reports no effort support ([] gate, §A4).
    private var effortRow: some View {
        Button { showEffort = true } label: {
            HStack {
                Text("Effort")
                    .font(EosFont.label)
                    .foregroundStyle(EosColor.ink)
                Spacer()
                Text(currentEffortLabel)
                    .font(EosFont.label)
                    .foregroundStyle(EosColor.inkSecondary)
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(EosColor.inkTertiary)
            }
            .padding(.horizontal, EosSpacing.md)
            .padding(.vertical, 14)
            .background(EosColor.surface2,
                        in: RoundedRectangle(cornerRadius: EosRadius.card, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, EosSpacing.screenInset)
        .padding(.vertical, EosSpacing.sm)
    }

    private var currentEffortLabel: String {
        ModelCatalog.efforts.first { $0.id == currentEffort }?.label ?? currentEffort
    }

    // MARK: page 2 — effort

    private var effortPage: some View {
        VStack(spacing: 0) {
            EosSheetHeader("Effort", back: true) { showEffort = false }
            ScrollView {
                groupCard {
                    ForEach(effortChoices) { choice in
                        SelectRow(title: choice.label,
                                  subtitle: choice.id == "ultracode"
                                      ? "Extra effort plus workflows — heaviest on limits" : nil,
                                  selected: currentEffort == choice.id) {
                            pickEffort(choice.id)
                        }
                    }
                }
                .padding(.horizontal, EosSpacing.screenInset)
            }
        }
        .background(EosColor.surface)
    }

    // MARK: commits — immediate, no auto-dismiss (X closes, §C6)

    private func pickModel(_ choice: ModelChoice) {
        Haptics.tap()
        currentProfile = nil
        currentModel = choice.alias
        clampEffort(to: choice)
        commit()
    }

    private func pickProviderModel(_ id: String) {
        Haptics.tap()
        currentModel = id
        commit()
    }

    // Picking a provider swaps page 1 to its model list, defaulting to the profile's pinned
    // model (Mac SpawnBackendMenu rule); the fetch fills the list lazily.
    private func pickProfile(_ profile: BackendProfile) {
        Haptics.tap()
        if currentProfile == nil { lastClaudeModel = currentModel }
        currentProfile = profile.name
        currentModel = profile.model
        commit()
        loadModels(for: profile)
    }

    // Back to the subscription lane: restore the curated families and the last Claude pick.
    private func pickClaude() {
        Haptics.tap()
        guard currentProfile != nil else { return }
        currentProfile = nil
        currentModel = lastClaudeModel ?? ModelCatalog.defaultModelAlias
        clampEffort(to: resolvedChoice)
        commit()
    }

    private func pickEffort(_ id: String) {
        Haptics.tap()
        currentEffort = id
        commit()
        showEffort = false   // pop to page 1
    }

    // Clamp the effort to the model's gate so the commit never carries an unsupported level.
    private func clampEffort(to choice: ModelChoice?) {
        let gate = ModelCatalog.effortChoices(for: choice)
        if !gate.isEmpty, !gate.contains(where: { $0.id == currentEffort }) {
            currentEffort = gate.contains { $0.id == ModelCatalog.defaultEffort }
                ? ModelCatalog.defaultEffort : gate[gate.count - 1].id
        }
    }

    private func loadModels(for profile: BackendProfile) {
        guard providerModels[profile.name] == nil,
              !loadingProviders.contains(profile.name) else { return }
        loadingProviders.insert(profile.name)
        Task {
            let fetched = await model.fetchBackendModels(profile.name)
            loadingProviders.remove(profile.name)
            providerModels[profile.name] = fetched ?? BackendModels(models: [], error: "couldn't load models")
        }
    }

    private func commit() {
        let value = ModelCatalog.commitModel(profile: activeProfile?.name, model: currentModel,
                                             in: claudeChoices)
        switch context {
        case .draft(let m, let e, let bp):
            m.wrappedValue = value
            e.wrappedValue = currentEffort
            bp.wrappedValue = currentProfile
        case .worker(let w):
            Task { await model.setModel(w.id, model: value, effort: currentEffort) }
        }
    }
}

#Preview("ModelSheet — draft") {
    struct Harness: View {
        @State private var shown = true
        @State private var model = "opus"
        @State private var effort = "xhigh"
        @State private var profile: String?
        var body: some View {
            EosColor.bg.ignoresSafeArea()
                .sheet(isPresented: $shown) {
                    ModelSheet(context: .draft(model: $model, effort: $effort, backendProfile: $profile))
                        .environmentObject(AppModel())
                }
        }
    }
    return Harness()
}
