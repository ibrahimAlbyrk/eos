import AppKit

// Resolves the user's default application for opening a file or extension.
// Invocation:
//   swift macos-default-app.swift /abs/path/to/file
//   swift macos-default-app.swift --ext md       (extension-only lookup; file may not exist)
//
// Exit codes:
//   0 — printed: <bundlePath>\n<bundleId>\n<displayName>
//   1 — no default app
//   2 — bad usage

guard CommandLine.arguments.count >= 2 else { exit(2) }

let arg1 = CommandLine.arguments[1]

func appURLForFile(_ path: String) -> URL? {
    let url = URL(fileURLWithPath: path)
    return NSWorkspace.shared.urlForApplication(toOpen: url)
}

func appURLForExtension(_ ext: String) -> URL? {
    // Create a throwaway file in a temp dir so LaunchServices can resolve the
    // UTI from extension. The file is removed immediately after the query.
    let tmpDir = FileManager.default.temporaryDirectory
    let tmpPath = tmpDir.appendingPathComponent("cm-uti-probe.\(ext)")
    let data = Data()
    do {
        try data.write(to: tmpPath)
    } catch {
        return nil
    }
    defer { try? FileManager.default.removeItem(at: tmpPath) }
    return NSWorkspace.shared.urlForApplication(toOpen: tmpPath)
}

let appURL: URL?
if arg1 == "--ext" {
    guard CommandLine.arguments.count >= 3 else { exit(2) }
    appURL = appURLForExtension(CommandLine.arguments[2])
} else {
    appURL = appURLForFile(arg1)
}

guard let appURL = appURL else { exit(1) }

let bundle = Bundle(url: appURL)
let bundleId = bundle?.bundleIdentifier ?? ""
let displayName =
    (bundle?.infoDictionary?["CFBundleDisplayName"] as? String)
    ?? (bundle?.infoDictionary?["CFBundleName"] as? String)
    ?? appURL.deletingPathExtension().lastPathComponent

print(appURL.path)
print(bundleId)
print(displayName)
