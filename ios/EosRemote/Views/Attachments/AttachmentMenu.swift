import SwiftUI
import UIKit
import PhotosUI
import UniformTypeIdentifiers

// The composer ⊕ menu content + native-picker glue (contract §C8, ref IMG_4431). The menu itself
// is P1's ChatComposer `Menu` — this supplies its three items; the owning screen applies
// `.attachmentPickers(...)` to host the camera / PhotosPicker / file-importer presentations that
// feed the AttachmentDraftModel pipeline (normalize → upload → chip).
struct AttachmentMenu {
    @MainActor
    static func content(draft: AttachmentDraftModel,
                        presentCamera: Binding<Bool>, presentPhotos: Binding<Bool>,
                        presentFiles: Binding<Bool>) -> AnyView {
        AnyView(Group {
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button { presentCamera.wrappedValue = true } label: {
                    Label("Take Photo", systemImage: "camera")
                }
            }
            Button { presentPhotos.wrappedValue = true } label: {
                Label("Choose photo or video", systemImage: "photo.on.rectangle")
            }
            Button { presentFiles.wrappedValue = true } label: {
                Label("Choose file", systemImage: "doc.text")
            }
        })
    }
}

extension View {
    func attachmentPickers(draft: AttachmentDraftModel,
                           camera: Binding<Bool>, photos: Binding<Bool>,
                           files: Binding<Bool>) -> some View {
        modifier(AttachmentPickersModifier(draft: draft, camera: camera, photos: photos, files: files))
    }
}

private struct AttachmentPickersModifier: ViewModifier {
    @ObservedObject var draft: AttachmentDraftModel
    @Binding var camera: Bool
    @Binding var photos: Bool
    @Binding var files: Bool

    @State private var photoSelection: [PhotosPickerItem] = []

    func body(content: Content) -> some View {
        content
            .fullScreenCover(isPresented: $camera) {
                CameraPicker { image in ingestCamera(image) }
                    .ignoresSafeArea()
            }
            .photosPicker(isPresented: $photos, selection: $photoSelection,
                          matching: .any(of: [.images, .videos]))
            .onChange(of: photoSelection) { _, items in
                guard !items.isEmpty else { return }
                photoSelection = []
                Task { await ingestPhotos(items) }
            }
            .fileImporter(isPresented: $files, allowedContentTypes: [.item],
                          allowsMultipleSelection: true) { result in
                guard case .success(let urls) = result else { return }
                for url in urls { ingestFile(url) }
            }
    }

    private func ingestCamera(_ image: UIImage) {
        let draft = self.draft
        Task.detached {
            guard let data = image.jpegData(compressionQuality: 0.95) else { return }
            let thumb = image.preparingThumbnail(of: thumbSize)
            await MainActor.run {
                draft.add(name: "photo.jpg", data: data, kind: .image, thumbnail: thumb)
            }
        }
    }

    // §C8: images normalize downstream (AttachmentDraftModel re-encodes JPEG ≤2048px); video
    // passes through as a raw file, no transcode — the 3 MB cap guards the relay envelope.
    private func ingestPhotos(_ items: [PhotosPickerItem]) async {
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let isImage = item.supportedContentTypes.contains { $0.conforms(to: .image) }
            if isImage {
                let thumb = UIImage(data: data)?.preparingThumbnail(of: thumbSize)
                draft.add(name: "photo.jpg", data: data, kind: .image, thumbnail: thumb)
            } else {
                let ext = item.supportedContentTypes
                    .first { $0.conforms(to: .movie) }?.preferredFilenameExtension ?? "mov"
                draft.add(name: "video.\(ext)", data: data, kind: .file, thumbnail: nil)
            }
        }
    }

    private func ingestFile(_ url: URL) {
        let draft = self.draft
        Task.detached {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { return }
            let isImage = UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true
            let thumb = isImage ? UIImage(data: data)?.preparingThumbnail(of: thumbSize) : nil
            await MainActor.run {
                draft.add(name: url.lastPathComponent, data: data,
                          kind: isImage ? .image : .file, thumbnail: thumb)
            }
        }
    }
}

// Chip thumbnails render at 56pt (@2x = 112px); kept file-level so Task.detached bodies read it
// without touching the modifier's main-actor state.
private let thumbSize = CGSize(width: 112, height: 112)

// Full-screen camera capture (§C8 "Take Photo") — UIImagePickerController is still the least
//-ceremony camera path; NSCameraUsageDescription ships in Info.plist already.
private struct CameraPicker: UIViewControllerRepresentable {
    @Environment(\.dismiss) private var dismiss
    let onImage: (UIImage) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onImage(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
