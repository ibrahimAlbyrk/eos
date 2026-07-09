import Foundation

// NSCache-backed source→tree cache (spec 03 §5.1 — mirrors the Mac's LRU(400) text→html cache) so
// re-mounting a transcript doesn't re-parse every block. Keyed by the raw markdown string.
enum MarkdownCache {
    private final class Box { let doc: MarkdownDocument; init(_ d: MarkdownDocument) { doc = d } }
    // NSCache is internally thread-safe; the unsafe annotation just opts out of the Sendable check.
    nonisolated(unsafe) private static let cache: NSCache<NSString, Box> = {
        let c = NSCache<NSString, Box>(); c.countLimit = 400; return c
    }()

    static func document(for source: String) -> MarkdownDocument {
        let key = source as NSString
        if let hit = cache.object(forKey: key) { return hit.doc }
        let doc = MarkdownDocument.parse(source)
        cache.setObject(Box(doc), forKey: key)
        return doc
    }
}
