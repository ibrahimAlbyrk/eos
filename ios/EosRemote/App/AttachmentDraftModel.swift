import Foundation
import UIKit
import EosRemoteKit

// One composer's attachment drafts (§C8): normalize → upload (POST /fs/paste-b64) → chip status
// flips. The resolved daemon path lives HERE keyed by chip label (AttachmentChipVM carries display
// state only); suffix() emits the Mac wire format via AttachmentTokens. Chip types
// (AttachmentChipVM / AttachmentKind / ChipStatus) are P1's ChatComposer contract.
@MainActor
final class AttachmentDraftModel: ObservableObject {
    @Published private(set) var items: [AttachmentChipVM] = []
    // Set when a payload is rejected (size cap); the composer surfaces it as an error capsule.
    @Published var lastError: String?

    // D-11: the relay envelope hard-caps frames at 5 MB and base64 inflates 4/3.
    static let maxPayloadBytes = 3 * 1024 * 1024
    private nonisolated static let maxImageEdge: CGFloat = 2048
    private nonisolated static let jpegQuality: CGFloat = 0.8

    private struct Payload {
        let name: String
        let data: Data
        let kind: AttachmentKind
        let thumbnail: UIImage?
        var path: String?
    }

    private var payloads: [String: Payload] = [:]   // by chip label; display order lives in `items`
    private let upload: (String, Data) async -> String?

    // `upload` is the device call (AppModel.uploadAttachment) so the model stays view-testable.
    init(upload: @escaping (String, Data) async -> String?) {
        self.upload = upload
    }

    var allReady: Bool {
        items.allSatisfy { if case .ready = $0.status { return true } else { return false } }
    }

    func add(name: String, data: Data, kind: AttachmentKind, thumbnail: UIImage? = nil) {
        Task { await addNormalized(name: name, data: data, kind: kind, thumbnail: thumbnail) }
    }

    func remove(label: String) {
        payloads[label] = nil
        items.removeAll { $0.label == label }
    }

    func retry(label: String) {
        Task { await runUpload(label: label) }
    }

    // The Mac wire suffix ("\n\nattachments:\n- [label] (kind): /abs/path") over the ready chips.
    func suffix() -> String {
        var paths: [String: String] = [:]
        var kinds: [String: String] = [:]
        for (label, payload) in payloads {
            guard let path = payload.path else { continue }
            paths[label] = path
            kinds[label] = payload.kind.rawValue
        }
        return AttachmentTokens.buildAttachmentSuffix(labels: items.map(\.label), paths: paths, kinds: kinds)
    }

    func clear() {
        items = []
        payloads = [:]
        lastError = nil
    }

    private func addNormalized(name: String, data: Data, kind: AttachmentKind, thumbnail: UIImage?) async {
        let payload: Data
        if kind == .image {
            payload = await Task.detached { Self.normalizeImage(data) }.value
        } else {
            payload = data
        }
        guard payload.count <= Self.maxPayloadBytes else {
            lastError = "Too large to send from phone — 3 MB max"
            return
        }
        let label = uniqueLabel(for: name)
        payloads[label] = Payload(name: name, data: payload, kind: kind, thumbnail: thumbnail, path: nil)
        items.append(AttachmentChipVM(id: label, label: label, kind: kind, status: .uploading, thumbnail: thumbnail))
        await runUpload(label: label)
    }

    private func runUpload(label: String) async {
        guard let payload = payloads[label] else { return }
        setStatus(label, .uploading)
        if let path = await upload(payload.name, payload.data) {
            payloads[label]?.path = path
            setStatus(label, .ready)
        } else {
            setStatus(label, .error)
        }
    }

    private func uniqueLabel(for name: String) -> String {
        var n = 1
        var label = AttachmentTokens.makeLabel(name, n: n)
        while payloads[label] != nil {
            n += 1
            label = AttachmentTokens.makeLabel(name, n: n)
        }
        return label
    }

    private func setStatus(_ label: String, _ status: ChipStatus) {
        guard let i = items.firstIndex(where: { $0.label == label }) else { return }
        let old = items[i]
        items[i] = AttachmentChipVM(id: old.id, label: old.label, kind: old.kind,
                                    status: status, thumbnail: old.thumbnail)
    }

    // §C8.1: camera/HEIC images re-encode as JPEG, longest edge ≤ 2048px, q0.8. Falls back to the
    // original bytes when decode fails — the size cap above still guards the envelope.
    private nonisolated static func normalizeImage(_ data: Data) -> Data {
        guard let image = UIImage(data: data) else { return data }
        let longest = max(image.size.width, image.size.height)
        guard longest > 0 else { return data }
        let scale = min(maxImageEdge / longest, 1)
        let target = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let rendered = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        return rendered.jpegData(compressionQuality: jpegQuality) ?? data
    }
}
