// Shares one kind of item through the extension named by its menu title, as the Share menu
// does: `drive <title> file <path> | text <text> | url <address>`.
import AppKit

let args = CommandLine.arguments
guard args.count == 4 else { print("usage: drive <title> file|text|url <value>"); exit(2) }
let item: Any
switch args[2] {
case "file": item = URL(fileURLWithPath: args[3])
case "url": item = URL(string: args[3])!
default: item = args[3] as NSString
}
NSApplication.shared.setActivationPolicy(.accessory)
let services = NSSharingService.sharingServices(forItems: [item])
guard let service = services.first(where: { $0.title == args[1] }) else {
  print("not offered; offered: \(services.map(\.title))")
  exit(3)
}
final class Done: NSObject, NSSharingServiceDelegate {
  func sharingService(_ s: NSSharingService, didShareItems items: [Any]) { print("shared")
    // The share menu's app stays open after a share; so does this one, for a while.
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { exit(0) } }
  func sharingService(_ s: NSSharingService, didFailToShareItems items: [Any], error: Error) {
    print("failed: \(error)"); exit(4)
  }
}
let done = Done()
service.delegate = done
service.perform(withItems: [item])
RunLoop.main.run(until: Date().addingTimeInterval(20))
print("no answer")
exit(5)
