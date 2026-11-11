// Prints the on-screen normal-layer window ids of a pid (for `screencapture -l`).
import CoreGraphics
import Foundation
let pid = Int(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
for w in list {
  guard (w[kCGWindowOwnerPID as String] as? Int) == pid, (w[kCGWindowLayer as String] as? Int) == 0 else { continue }
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  if (b["Width"] as? Double ?? 0) > 600 { print(w[kCGWindowNumber as String]!) }
}
