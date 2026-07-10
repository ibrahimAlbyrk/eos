import SwiftUI

// Repo picker (contract §C9, ref IMG_4436): page 1 = the daemon's MRU recents with a local
// search capsule pinned bottom; page 2 = the daemon-side directory browser over GET /fs/list
// (the Mac's /pick-directory dialog is REFUSED remotely — this browser replaces it, D-12).
// The chosen path is committed via the callback and NOT persisted app-side: the daemon's
// recents list learns it after the spawn.
struct RepoPickerSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    private let current: String?
    private let onPick: (String) -> Void

    @State private var recents: [String] = []
    @State private var loading = true
    @State private var search = ""
    @State private var showBrowser = false

    init(current: String?, onPick: @escaping (String) -> Void) {
        self.current = current
        self.onPick = onPick
    }

    var body: some View {
        NavigationStack {
            recentsPage
                .navigationBarBackButtonHidden(true)
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(isPresented: $showBrowser) {
                    DirectoryBrowserPage(root: browserRoot,
                                         onUse: { path in commit(path) },
                                         onExit: { showBrowser = false })
                        .navigationBarBackButtonHidden(true)
                        .toolbar(.hidden, for: .navigationBar)
                }
        }
        .eosSheet(detents: [.large])
        .task {
            recents = await model.fetchRecents()
            loading = false
        }
    }

    // D-12: /fs/list needs an absolute cwd — derive /Users/<name> from the first recent's first
    // two segments; no recents → filesystem root.
    private var browserRoot: String {
        guard let first = recents.first else { return "/" }
        let comps = first.split(separator: "/")
        guard comps.count >= 2, comps[0] == "Users" else { return "/" }
        return "/\(comps[0])/\(comps[1])"
    }

    private var filtered: [String] {
        let needle = search.trimmingCharacters(in: .whitespaces)
        guard !needle.isEmpty else { return recents }
        return recents.filter { $0.localizedCaseInsensitiveContains(needle) }
    }

    private func commit(_ path: String) {
        Haptics.tap()
        onPick(path)
        dismiss()
    }

    // MARK: page 1 — recents

    private var recentsPage: some View {
        VStack(spacing: 0) {
            EosSheetHeader("Choose folder") { dismiss() }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if loading {
                        ProgressView()
                            .tint(EosColor.inkTertiary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, EosSpacing.lg)
                    } else if recents.isEmpty {
                        Text("No recent folders on \(model.activeDevice?.label ?? "this Mac") — browse to pick one.")
                            .font(EosFont.caption)
                            .foregroundStyle(EosColor.inkSecondary)
                            .padding(.horizontal, EosSpacing.md)
                            .padding(.vertical, EosSpacing.sm)
                    } else {
                        ForEach(filtered, id: \.self) { path in
                            SelectRow(title: basename(path),
                                      subtitle: abbreviate(path),
                                      selected: path == current) {
                                commit(path)
                            }
                        }
                    }
                    SelectRow(icon: "folder.badge.plus", title: "Browse…", selected: false) {
                        showBrowser = true
                    }
                }
                .padding(.horizontal, EosSpacing.xs)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .background(EosColor.surface)
        .safeAreaInset(edge: .bottom) { searchField }
    }

    // Search capsule pinned bottom (ref IMG_4436) — filters the recents list locally. Floating
    // Liquid Glass over the scrolling rows, not an opaque strip.
    private var searchField: some View {
        HStack(spacing: EosSpacing.xs) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(EosColor.inkTertiary)
            TextField("Search", text: $search)
                .font(EosFont.body)
                .foregroundStyle(EosColor.ink)
                .tint(EosColor.coral)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
        }
        .padding(.horizontal, EosSpacing.md)
        .padding(.vertical, EosSpacing.sm)
        .glassEffect(.regular, in: .capsule)
        .padding(.horizontal, EosSpacing.screenInset)
        .padding(.vertical, EosSpacing.xs)
    }

    private func basename(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    // "/Users/x/…/parent" — first two segments + the chosen folder's parent (§C9).
    private func abbreviate(_ path: String) -> String {
        let comps = path.split(separator: "/").map(String.init)
        guard comps.count > 1 else { return "/" }
        let parents = comps.dropLast()
        guard parents.count > 3 else { return "/" + parents.joined(separator: "/") }
        return "/\(parents[0])/\(parents[1])/…/\(parents[parents.count - 1])"
    }
}

// MARK: page 2 — directory browser (daemon-side FS, directories only)

private struct DirectoryBrowserPage: View {
    @EnvironmentObject private var model: AppModel

    let root: String
    let onUse: (String) -> Void
    let onExit: () -> Void

    @State private var stack: [String] = []   // relative path segments under `root`
    @State private var entries: [FsDirEntry] = []
    @State private var loading = true

    private var title: String {
        stack.last ?? (root.split(separator: "/").last.map(String.init) ?? "/")
    }

    private var currentAbsolutePath: String {
        let rel = stack.joined(separator: "/")
        if root == "/" { return "/" + rel }
        return stack.isEmpty ? root : root + "/" + rel
    }

    var body: some View {
        VStack(spacing: 0) {
            EosSheetHeader(title, back: true) { back() }
            ScrollView {
                VStack(spacing: 0) {
                    if loading {
                        ProgressView()
                            .tint(EosColor.inkTertiary)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, EosSpacing.lg)
                    } else if entries.isEmpty {
                        Text("No subfolders here")
                            .font(EosFont.caption)
                            .foregroundStyle(EosColor.inkSecondary)
                            .padding(.vertical, EosSpacing.sm)
                    } else {
                        ForEach(entries) { entry in
                            SelectRow(icon: "folder", title: entry.name, selected: false) {
                                stack.append(entry.name)
                                Task { await load() }
                            }
                        }
                    }
                }
                .padding(.horizontal, EosSpacing.xs)
            }
        }
        .background(EosColor.surface)
        .safeAreaInset(edge: .bottom) {
            PillButton("Use this folder", style: .primary) { onUse(currentAbsolutePath) }
                .frame(maxWidth: .infinity)
                .padding(.vertical, EosSpacing.xs)
                .background(EosColor.surface)
        }
        .task { await load() }
    }

    private func back() {
        guard !stack.isEmpty else { onExit(); return }
        stack.removeLast()
        Task { await load() }
    }

    private func load() async {
        loading = true
        let snapshot = stack
        let rows = await model.listDirectories(cwd: root,
                                               dir: snapshot.isEmpty ? nil : snapshot.joined(separator: "/"))
        guard snapshot == stack else { return }   // a deeper tap superseded this fetch
        entries = rows.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        loading = false
    }
}

#Preview("RepoPickerSheet") {
    struct Harness: View {
        @State private var shown = true
        var body: some View {
            EosColor.bg.ignoresSafeArea()
                .sheet(isPresented: $shown) {
                    RepoPickerSheet(current: nil) { _ in }
                        .environmentObject(AppModel())
                }
        }
    }
    return Harness()
}
