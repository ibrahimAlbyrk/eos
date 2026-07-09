import XCTest
@testable import EosRemoteKit

// AttachmentTokens (§C8): label formatting, the wire suffix, and its inverse parser — must match
// the Mac's lib/attachmentTokens.js byte-for-byte on the wire format.
final class AttachmentTokensTests: XCTestCase {

    // MARK: makeLabel

    func testMakeLabelBasic() {
        XCTAssertEqual(AttachmentTokens.makeLabel("report.pdf"), "[report.pdf]")
    }

    func testMakeLabelStripsBracketsAndNewlines() {
        XCTAssertEqual(AttachmentTokens.makeLabel("a[b]c\nd"), "[abcd]")
    }

    func testMakeLabelEmptyFallsBackToFile() {
        XCTAssertEqual(AttachmentTokens.makeLabel(""), "[file]")
        XCTAssertEqual(AttachmentTokens.makeLabel(nil), "[file]")
        XCTAssertEqual(AttachmentTokens.makeLabel("   "), "[file]")
    }

    func testMakeLabelCapsAt24CharsWithEllipsis() {
        let name = "abcdefghijklmnopqrstuvwxyz1234"   // 30 chars
        XCTAssertEqual(AttachmentTokens.makeLabel(name), "[abcdefghijklmnopqrstuvwx…]")
    }

    func testMakeLabelDedupeSuffix() {
        XCTAssertEqual(AttachmentTokens.makeLabel("a.txt", n: 2), "[a.txt 2]")
        XCTAssertEqual(AttachmentTokens.makeLabel("a.txt", n: 1), "[a.txt]")
    }

    // MARK: buildAttachmentSuffix

    func testBuildSuffixVerbatimWireFormat() {
        let suffix = AttachmentTokens.buildAttachmentSuffix(
            labels: ["[a.png]", "[b.txt]"],
            paths: ["[a.png]": "/tmp/a.png", "[b.txt]": "/tmp/b.txt"],
            kinds: ["[a.png]": "image", "[b.txt]": "file"])
        XCTAssertEqual(suffix, "\n\nattachments:\n- [a.png] (image): /tmp/a.png\n- [b.txt] (file): /tmp/b.txt")
    }

    func testBuildSuffixSkipsLabelsWithoutPath() {
        let suffix = AttachmentTokens.buildAttachmentSuffix(
            labels: ["[up]", "[pending]"], paths: ["[up]": "/tmp/up"])
        XCTAssertEqual(suffix, "\n\nattachments:\n- [up]: /tmp/up")
    }

    func testBuildSuffixEmptyWhenNothingReady() {
        XCTAssertEqual(AttachmentTokens.buildAttachmentSuffix(labels: ["[x]"], paths: [:]), "")
        XCTAssertEqual(AttachmentTokens.buildAttachmentSuffix(labels: [], paths: [:]), "")
    }

    // MARK: parseAttachmentMessage

    func testParseRoundtrip() {
        let suffix = AttachmentTokens.buildAttachmentSuffix(
            labels: ["[shot.png]", "[notes.txt]"],
            paths: ["[shot.png]": "/tmp/shot.png", "[notes.txt]": "/tmp/notes.txt"],
            kinds: ["[shot.png]": "image", "[notes.txt]": "file"])
        let parsed = AttachmentTokens.parseAttachmentMessage("look at these" + suffix)
        XCTAssertEqual(parsed.display, "look at these")
        XCTAssertEqual(parsed.attachments, [
            AttachmentTokens.ParsedAttachment(label: "[shot.png]", kind: "image", path: "/tmp/shot.png"),
            AttachmentTokens.ParsedAttachment(label: "[notes.txt]", kind: "file", path: "/tmp/notes.txt"),
        ])
    }

    func testParseNoMarkerYieldsPlainDisplay() {
        let parsed = AttachmentTokens.parseAttachmentMessage("just text, no attachments")
        XCTAssertEqual(parsed.display, "just text, no attachments")
        XCTAssertTrue(parsed.attachments.isEmpty)
    }

    func testParseInfersKindFromExtensionWhenAnnotationAbsent() {
        let parsed = AttachmentTokens.parseAttachmentMessage("hi\n\nattachments:\n- [x]: /tmp/pic.png\n- [y]: /tmp/doc.md")
        XCTAssertEqual(parsed.attachments.map(\.kind), ["image", "file"])
    }

    func testParseKeepsFolderAnnotation() {
        let parsed = AttachmentTokens.parseAttachmentMessage("hi\n\nattachments:\n- [dir] (folder): /tmp/proj")
        XCTAssertEqual(parsed.attachments, [
            AttachmentTokens.ParsedAttachment(label: "[dir]", kind: "folder", path: "/tmp/proj"),
        ])
    }

    func testParseLegacyCurlyForm() {
        let parsed = AttachmentTokens.parseAttachmentMessage("hi\n\nattachments:\n- {image #1}: /tmp/x.png")
        XCTAssertEqual(parsed.attachments, [
            AttachmentTokens.ParsedAttachment(label: "{image #1}", kind: "image", path: "/tmp/x.png"),
        ])
    }

    func testParseBareKindForm() {
        let parsed = AttachmentTokens.parseAttachmentMessage("hi\n\nattachments:\n- file: /tmp/z")
        XCTAssertEqual(parsed.attachments, [
            AttachmentTokens.ParsedAttachment(label: nil, kind: "file", path: "/tmp/z"),
        ])
    }

    func testParseUnstructuredLineFallsBackToExtension() {
        let parsed = AttachmentTokens.parseAttachmentMessage("hi\n\nattachments:\n/tmp/raw.jpeg")
        XCTAssertEqual(parsed.attachments, [
            AttachmentTokens.ParsedAttachment(label: nil, kind: "image", path: "/tmp/raw.jpeg"),
        ])
    }
}
