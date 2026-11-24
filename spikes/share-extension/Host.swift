// The spike's stand-in for Eos: a plain app (not sandboxed) that writes every URL the system
// opens with it to `received.txt` beside its bundle, one per line, and quits after a while.
import AppKit

final class Recorder: NSObject, NSApplicationDelegate {
  let log = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("received.txt")

  func application(_ application: NSApplication, open urls: [URL]) {
    let lines = urls.map { $0.absoluteString + "\n" }.joined()
    if let handle = try? FileHandle(forWritingTo: log) {
      handle.seekToEndOfFile()
      handle.write(Data(lines.utf8))
      try? handle.close()
    } else {
      try? Data(lines.utf8).write(to: log)
    }
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 60) { NSApp.terminate(nil) }
  }
}

let recorder = Recorder()
NSApplication.shared.delegate = recorder
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
