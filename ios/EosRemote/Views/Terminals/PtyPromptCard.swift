import SwiftUI
import EosRemoteKit

// The claude pane's pending dialog as a card above the composer (PermissionBanner chrome):
// AskUserQuestion one question per step, or an ExitPlanMode plan to approve. The host keys it by
// toolUseId, so a new prompt starts fresh; after a successful submit it stays disabled until the
// transcript resolves the prompt and the card goes away.
struct PtyPromptCard: View {
    let prompt: PendingPrompt
    let onAnswer: ([PendingAnswer]) async -> Bool
    let onApprove: () async -> Bool
    let onAnswerInTerminal: () -> Void

    var body: some View {
        switch prompt {
        case .questions(_, let questions):
            QuestionSteps(questions: questions, onSubmit: onAnswer)
        case .plan(_, let markdown):
            PlanApproval(markdown: markdown, onApprove: onApprove, onAnswerInTerminal: onAnswerInTerminal)
        }
    }
}

private struct QuestionSteps: View {
    let questions: [PendingQuestion]
    let onSubmit: ([PendingAnswer]) async -> Bool

    @State private var step = 0
    @State private var picks: [Set<Int>]
    @State private var otherOn: [Bool]
    @State private var otherText: [String]
    @State private var busy = false
    @FocusState private var otherFocused: Bool

    init(questions: [PendingQuestion], onSubmit: @escaping ([PendingAnswer]) async -> Bool) {
        self.questions = questions
        self.onSubmit = onSubmit
        _picks = State(initialValue: Array(repeating: [], count: questions.count))
        _otherOn = State(initialValue: Array(repeating: false, count: questions.count))
        _otherText = State(initialValue: Array(repeating: "", count: questions.count))
    }

    private var question: PendingQuestion { questions[step] }
    private var isLast: Bool { step == questions.count - 1 }

    var body: some View {
        VStack(alignment: .leading, spacing: EosSpacing.sm) {
            HStack(spacing: EosSpacing.xs) {
                if let header = question.header, !header.isEmpty {
                    Text(header)
                        .font(EosFont.captionSmall)
                        .foregroundStyle(EosColor.coral)
                        .padding(.horizontal, EosSpacing.xs)
                        .padding(.vertical, 3)
                        .background(EosColor.coralWash, in: Capsule())
                }
                Spacer(minLength: 0)
                if questions.count > 1 {
                    Text("\(step + 1) of \(questions.count)")
                        .font(EosFont.captionSmall)
                        .foregroundStyle(EosColor.inkTertiary)
                }
            }
            Text(question.question)
                .font(EosFont.label)
                .foregroundStyle(EosColor.ink)
                .fixedSize(horizontal: false, vertical: true)
            VStack(spacing: 2) {
                ForEach(Array(question.options.enumerated()), id: \.offset) { i, option in
                    optionRow(option.label, detail: option.description, selected: picks[step].contains(i)) {
                        pick(i)
                    }
                }
                // Claude Code's own "Other" entry: free text, single-select only.
                if !question.multiSelect {
                    optionRow("Other…", detail: nil, selected: otherOn[step]) { pickOther() }
                    if otherOn[step] {
                        TextField("Your answer", text: $otherText[step], axis: .vertical)
                            .font(EosFont.body)
                            .lineLimit(1...4)
                            .tint(EosColor.coral)
                            .focused($otherFocused)
                            .padding(EosSpacing.xs)
                            .background(EosColor.surface3,
                                        in: RoundedRectangle(cornerRadius: EosRadius.chip, style: .continuous))
                    }
                }
            }
            HStack(spacing: EosSpacing.xs) {
                if step > 0 {
                    BannerActionButton("Back", tint: EosColor.ink, filled: false) { step -= 1 }
                }
                Spacer()
                BannerActionButton(isLast ? "Submit" : "Next", tint: EosColor.onAccent, filled: true) { advance() }
                    .disabled(answer(step) == nil)
                    .opacity(answer(step) == nil ? 0.45 : 1)
            }
        }
        .bannerCard()
        .disabled(busy)
        .opacity(busy ? 0.55 : 1)
    }

    private func optionRow(_ label: String, detail: String?, selected: Bool,
                           action: @escaping () -> Void) -> some View {
        Button {
            Haptics.tap()
            action()
        } label: {
            HStack(alignment: .top, spacing: EosSpacing.xs) {
                Image(systemName: glyph(selected))
                    .font(.system(size: 16, weight: .regular))
                    .foregroundStyle(selected ? EosColor.coral : EosColor.inkTertiary)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    Text(label)
                        .font(EosFont.label)
                        .foregroundStyle(EosColor.ink)
                    if let detail, !detail.isEmpty {
                        Text(detail)
                            .font(EosFont.caption)
                            .foregroundStyle(EosColor.inkSecondary)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, EosSpacing.xs)
            .padding(.vertical, 6)
            .background(selected ? EosColor.coralWash : .clear,
                        in: RoundedRectangle(cornerRadius: EosRadius.chip, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func glyph(_ selected: Bool) -> String {
        if question.multiSelect { return selected ? "checkmark.square.fill" : "square" }
        return selected ? "largecircle.fill.circle" : "circle"
    }

    private func pick(_ i: Int) {
        if question.multiSelect {
            if picks[step].contains(i) { picks[step].remove(i) } else { picks[step].insert(i) }
        } else {
            picks[step] = [i]
            otherOn[step] = false
            otherFocused = false
        }
    }

    private func pickOther() {
        picks[step] = []
        otherOn[step] = true
        otherFocused = true
    }

    // The wire answer for question `i`, nil until it has one.
    private func answer(_ i: Int) -> PendingAnswer? {
        if otherOn[i] {
            let text = otherText[i].trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : .text(text)
        }
        return picks[i].isEmpty ? nil : .options(picks[i].sorted())
    }

    private func advance() {
        otherFocused = false
        guard isLast else { step += 1; return }
        let answers = questions.indices.compactMap(answer)
        guard answers.count == questions.count else { return }
        busy = true
        Haptics.success()
        Task { if !(await onSubmit(answers)) { busy = false } }
    }
}

private struct PlanApproval: View {
    let markdown: String
    let onApprove: () async -> Bool
    let onAnswerInTerminal: () -> Void

    @State private var expanded = false
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: EosSpacing.sm) {
            Button {
                withAnimation(EosSpring.chip) { expanded.toggle() }
            } label: {
                HStack(spacing: EosSpacing.xs) {
                    Circle()
                        .fill(EosColor.State.waitingDot)
                        .frame(width: 8, height: 8)
                    Text("Plan ready for review")
                        .font(EosFont.label)
                        .foregroundStyle(EosColor.ink)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(EosColor.inkTertiary)
                        .rotationEffect(.degrees(expanded ? -180 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(expanded ? "Hide plan" : "Show plan")
            Group {
                if expanded {
                    ScrollView { MarkdownView(source: markdown) }
                        .frame(maxHeight: 280)
                } else {
                    Text(markdown)
                        .font(EosFont.caption)
                        .foregroundStyle(EosColor.inkSecondary)
                        .lineLimit(3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(EosSpacing.xs)
            .background(EosColor.surface3, in: RoundedRectangle(cornerRadius: EosRadius.chip, style: .continuous))
            HStack(spacing: EosSpacing.xs) {
                BannerActionButton("Answer in terminal", tint: EosColor.ink, filled: false, action: onAnswerInTerminal)
                Spacer()
                BannerActionButton("Approve plan", tint: EosColor.onAccent, filled: true) {
                    busy = true
                    Haptics.success()
                    Task { if !(await onApprove()) { busy = false } }
                }
            }
            .disabled(busy)
            .opacity(busy ? 0.55 : 1)
        }
        .bannerCard()
    }
}
