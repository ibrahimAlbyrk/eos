import SwiftUI

// Bottom-sheet chrome (contract §A3, ref IMG_4424/4430/4436): every sheet in the app shares one
// anatomy — our own grabber capsule, a header row with a glass X (or back) circle and a centered
// title, over an opaque `surface` presentation background (reference sheets are opaque, not
// translucent — §A2 class 2). The system drag indicator is hidden; the grabber here replaces it.

struct EosSheetHeader: View {
    let title: String
    var back: Bool = false
    let onClose: () -> Void

    init(_ title: String, back: Bool = false, onClose: @escaping () -> Void) {
        self.title = title
        self.back = back
        self.onClose = onClose
    }

    var body: some View {
        VStack(spacing: EosSpacing.xs) {
            Capsule()
                .fill(EosColor.inkFaint)
                .frame(width: EosSpacing.grabberW, height: EosSpacing.grabberH)
                .padding(.top, 10)
            HStack {
                CircularIconButton(systemName: back ? "chevron.backward" : "xmark",
                                   diameter: 36, glass: true,
                                   accessibilityLabel: back ? "Back" : "Close",
                                   action: onClose)
                Spacer()
                Text(title)
                    .font(EosFont.labelStrong)
                    .foregroundStyle(EosColor.ink)
                    .lineLimit(1)
                Spacer()
                Color.clear.frame(width: 36, height: 36)   // mirrors the button so the title centers
            }
            .padding(.horizontal, EosSpacing.screenInset)
        }
        .padding(.bottom, EosSpacing.md)   // content begins 16pt below the header
    }
}

extension View {
    /// Shared bottom-sheet presentation chrome (§A3): opaque surface, 32pt top corners, hidden
    /// system grabber (EosSheetHeader draws its own), caller-chosen detents.
    func eosSheet(detents: Set<PresentationDetent>) -> some View {
        self
            .presentationDetents(detents)
            .presentationDragIndicator(.hidden)
            .presentationBackground(EosColor.surface)
            .presentationCornerRadius(EosRadius.sheet)
    }
}

#Preview("Sheet chrome") {
    struct Harness: View {
        @State private var shown = true
        var body: some View {
            EosColor.bg.ignoresSafeArea()
                .sheet(isPresented: $shown) {
                    VStack(alignment: .leading, spacing: EosSpacing.md) {
                        EosSheetHeader("Select model") {}
                        Text("Sheet content starts here")
                            .font(EosFont.body)
                            .foregroundStyle(EosColor.inkSecondary)
                            .padding(.horizontal, EosSpacing.screenInset)
                        Spacer()
                    }
                    .eosSheet(detents: [.medium, .large])
                }
        }
    }
    return Harness()
}

#Preview("Header — back variant") {
    VStack {
        EosSheetHeader("Effort", back: true) {}
        Spacer()
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(EosColor.surface)
}
