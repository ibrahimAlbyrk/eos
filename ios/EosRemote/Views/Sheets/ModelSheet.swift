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
// curated Claude families (+ provider profiles in draft context) with the pinned Effort row,
// page 2 = the per-model effort list. Rows come from ModelCatalog over /api/ui-config — no
// hardcoded model lists; baseline families render until the config arrives (offline-safe).
// Selection commits immediately; the sheet stays open until X (ref behavior).
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
        isWorkerContext ? [] : (model.uiConfig?.backendProfiles ?? [])
    }

    private var resolvedChoice: ModelChoice? { ModelCatalog.resolve(currentModel, in: claudeChoices) }
    // PUT/spawn commit value is the family alias (Mac ModelPopover rule); raw ids pass through
    // untouched when the catalog can't resolve them.
    private var commitAlias: String { resolvedChoice?.alias ?? currentModel }

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
            guard model.uiConfig == nil else { return }
            fetching = true
            fetchFailed = await model.fetchUiConfig() == nil
            fetching = false
        }
    }

    // MARK: page 1 — models

    private var modelsPage: some View {
        VStack(spacing: 0) {
            EosSheetHeader("Select model") { dismiss() }
            ScrollView {
                VStack(alignment: .leading, spacing: EosSpacing.xs) {
                    if !profiles.isEmpty { SectionCaption("Claude") }
                    groupCard {
                        ForEach(claudeChoices) { choice in
                            SelectRow(title: choice.displayName,
                                      subtitle: subtitle(for: choice),
                                      selected: currentProfile == nil && resolvedChoice?.id == choice.id) {
                                pickModel(choice)
                            }
                        }
                    }
                    if !profiles.isEmpty {
                        SectionCaption("Providers")
                        groupCard {
                            ForEach(profiles) { p in
                                SelectRow(title: p.label,
                                          subtitle: "\(p.kind) · \(p.model)",
                                          selected: currentProfile == p.name) {
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
                        Text("showing defaults")
                            .font(EosFont.captionSmall)
                            .foregroundStyle(EosColor.inkTertiary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, EosSpacing.xs)
                    }
                }
                .padding(.horizontal, EosSpacing.screenInset)
            }
            if !effortChoices.isEmpty { effortRow }
        }
        .background(EosColor.surface)
    }

    private func groupCard<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0, content: content)
            .background(EosColor.surface2,
                        in: RoundedRectangle(cornerRadius: EosRadius.card, style: .continuous))
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
        // Clamp the effort to the new model's gate so the commit never carries an unsupported level.
        let gate = ModelCatalog.effortChoices(for: choice)
        if !gate.isEmpty, !gate.contains(where: { $0.id == currentEffort }) {
            currentEffort = gate.contains { $0.id == ModelCatalog.defaultEffort }
                ? ModelCatalog.defaultEffort : gate[gate.count - 1].id
        }
        commit()
    }

    private func pickProfile(_ profile: BackendProfile) {
        Haptics.tap()
        currentProfile = profile.name
        commit()
    }

    private func pickEffort(_ id: String) {
        Haptics.tap()
        currentEffort = id
        commit()
        showEffort = false   // pop to page 1
    }

    private func commit() {
        switch context {
        case .draft(let m, let e, let bp):
            m.wrappedValue = commitAlias
            e.wrappedValue = currentEffort
            bp.wrappedValue = currentProfile
        case .worker(let w):
            Task { await model.setModel(w.id, model: commitAlias, effort: currentEffort) }
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
