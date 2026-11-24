import SwiftUI
import UIKit
import UniformTypeIdentifiers
import EosRemoteKit

// The share extension's entry (07 §4.8): reads the shared link or text and shows the run sheet.
final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: ShareView(model: model) { [weak self] in self?.finish() })
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)

        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let title = items.lazy.compactMap { $0.attributedTitle?.string ?? $0.attributedContentText?.string }.first
        let providers = items.flatMap { $0.attachments ?? [] }
        Task { [model] in
            let url = await Self.first(URL.self, of: UTType.url, in: providers)
            let text = url == nil ? await Self.first(String.self, of: UTType.plainText, in: providers) : nil
            await model.load(SharedThing.of(url: url, text: text, title: title))
        }
    }

    private func finish() {
        Task { [model, weak self] in
            await model.close()
            self?.extensionContext?.completeRequest(returningItems: nil)
        }
    }

    /// The first attachment of `type`, read as `T`.
    private static func first<T: _ObjectiveCBridgeable & Sendable>(
        _: T.Type, of type: UTType, in providers: [NSItemProvider]
    ) async -> T? where T._ObjectiveCType: NSItemProviderReading {
        guard let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(type.identifier) })
        else { return nil }
        return await withCheckedContinuation { done in
            _ = provider.loadObject(ofClass: T.self) { value, _ in done.resume(returning: value) }
        }
    }
}
