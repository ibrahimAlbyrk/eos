// The share extension: no UI of its own. It hands what was shared to the app that contains it
// and completes at once: files are opened with that app (the Dock's path), text and one web
// address go as a `send` link in the app's own scheme. Both are opened with the containing app
// by its location, so a share never reaches another build that answers the same scheme.
import AppKit
import UniformTypeIdentifiers

/// The longest link the app reads (`eos_bridge::links::MAX_LINK`).
let maxLink = 8 * 1024
/// What a query value may hold unescaped: `+` is escaped, since the app reads it as a space.
let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

@objc(ShareViewController)
final class ShareViewController: NSViewController {
  override var nibName: NSNib.Name? { nil }

  override func loadView() { view = NSView(frame: .zero) }

  override func beginRequest(with context: NSExtensionContext) {
    super.beginRequest(with: context)
    let items = context.inputItems as? [NSExtensionItem] ?? []
    // Text the user selected arrives as the item's own content, not as an attachment.
    let texts = items.compactMap { $0.attributedContentText?.string }
    let providers = items.flatMap { $0.attachments ?? [] }
    Task { @MainActor in
      await hand(providers, texts)
      context.completeRequest(returningItems: nil)
    }
  }
}

/// The containing app: `<app>/Contents/PlugIns/<this>.appex`.
func containingApp() -> URL {
  Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
}

/// The containing app's link scheme, written into this extension's Info.plist by the build.
func linkScheme() -> String? {
  Bundle.main.object(forInfoDictionaryKey: "EosLinkScheme") as? String
}

@MainActor
func hand(_ providers: [NSItemProvider], _ texts: [String]) async {
  var files: [URL] = []
  var links: [URL] = texts.filter { !$0.isEmpty }.compactMap { sendLink("text", $0) }
  for provider in providers {
    if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
      if let url = await loadURL(provider, UTType.fileURL), url.isFileURL { files.append(url) }
    } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
      if let url = await loadURL(provider, UTType.url), ["http", "https"].contains(url.scheme ?? ""), let link = sendLink("url", url.absoluteString) {
        links.append(link)
      }
    } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
      if let text = await loadText(provider), !text.isEmpty, let link = sendLink("text", text) {
        links.append(link)
      }
    }
  }
  let app = containingApp()
  for batch in [files, links] where !batch.isEmpty {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    _ = try? await NSWorkspace.shared.open(batch, withApplicationAt: app, configuration: configuration)
  }
}

/// `<scheme>://send?<key>=<value>`, the value cut at a character so the link stays readable.
func sendLink(_ key: String, _ value: String) -> URL? {
  guard let scheme = linkScheme() else { return nil }
  let head = "\(scheme)://send?\(key)="
  let whole = value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
  var body = ""
  for character in value {
    let escaped = String(character).addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
    if head.utf8.count + body.utf8.count + escaped.utf8.count > maxLink { break }
    body += escaped
  }
  // An address cut short is another address: it is sent whole or not at all.
  if key == "url" && body != whole { return nil }
  return body.isEmpty ? nil : URL(string: head + body)
}

func loadURL(_ provider: NSItemProvider, _ type: UTType) async -> URL? {
  let item = try? await provider.loadItem(forTypeIdentifier: type.identifier)
  switch item {
  case let url as URL: return url
  case let data as Data: return URL(dataRepresentation: data, relativeTo: nil)
  case let text as String: return URL(string: text)
  default: return nil
  }
}

func loadText(_ provider: NSItemProvider) async -> String? {
  let item = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier)
  switch item {
  case let text as String: return text
  case let text as NSAttributedString: return text.string
  case let data as Data: return String(data: data, encoding: .utf8)
  default: return nil
  }
}
