import XCTest
@testable import EosRemoteKit

// Round 4 file viewer logic: the /fs/read payload decode (three contract shapes), the image-route
// predicate, the extension → highlight.js map, the gutter line splitter, and the asset-frame decode
// the /fs/image fetch rides on (§5.4.5 frozen shape).
final class FileViewerTests: XCTestCase {

    // MARK: /fs/read payload shapes (FsReadResponseSchema)

    func testParseReadPayloadText() {
        let raw = JSONValue.parse(#"{"path":"/a/b.swift","content":"let x = 1\n","lines":2,"size":10}"#)!
        XCTAssertEqual(FileViewer.parseReadPayload(raw), .text(content: "let x = 1\n", lines: 2))
    }

    func testParseReadPayloadBinary() {
        let raw = JSONValue.parse(#"{"path":"/a/b.bin","binary":true,"size":2048}"#)!
        XCTAssertEqual(FileViewer.parseReadPayload(raw), .binary(size: 2048))
    }

    func testParseReadPayloadLarge() {
        let raw = JSONValue.parse(#"{"path":"/a/big.txt","large":true,"size":9000000}"#)!
        XCTAssertEqual(FileViewer.parseReadPayload(raw), .large(size: 9_000_000))
    }

    func testParseReadPayloadRejectsErrorShape() {
        let raw = JSONValue.parse(#"{"error":"ENOENT"}"#)!
        XCTAssertNil(FileViewer.parseReadPayload(raw))
    }

    // Empty file: content present ("") must decode as text, not fall through to nil.
    func testParseReadPayloadEmptyText() {
        let raw = JSONValue.parse(#"{"path":"/a/empty","content":"","lines":1,"size":0}"#)!
        XCTAssertEqual(FileViewer.parseReadPayload(raw), .text(content: "", lines: 1))
    }

    // MARK: image predicate + language map

    func testIsImagePathMatchesDaemonMimeSet() {
        XCTAssertTrue(FileViewer.isImagePath("/x/shot.PNG"))
        XCTAssertTrue(FileViewer.isImagePath("/x/photo.jpeg"))
        XCTAssertTrue(FileViewer.isImagePath("/x/pic.webp"))
        // svg is XML text — served by /fs/read + highlighting, not UIImage.
        XCTAssertFalse(FileViewer.isImagePath("/x/icon.svg"))
        XCTAssertFalse(FileViewer.isImagePath("/x/main.swift"))
        XCTAssertFalse(FileViewer.isImagePath("/x/noext"))
    }

    func testLanguageForPath() {
        XCTAssertEqual(FileViewer.languageForPath("/a/Main.swift"), "swift")
        XCTAssertEqual(FileViewer.languageForPath("/a/http.ts"), "typescript")
        XCTAssertEqual(FileViewer.languageForPath("/a/icon.svg"), "xml")
        XCTAssertNil(FileViewer.languageForPath("/a/Makefile"))
    }

    // MARK: line splitter

    func testSplitLinesBasic() {
        let lines = FileViewer.splitLines(AttributedString("a\nbb\nccc"))
        XCTAssertEqual(lines.map { String($0.characters) }, ["a", "bb", "ccc"])
    }

    func testSplitLinesTrailingNewlineYieldsEmptyLastLine() {
        let lines = FileViewer.splitLines(AttributedString("a\n"))
        XCTAssertEqual(lines.map { String($0.characters) }, ["a", ""])
    }

    func testSplitLinesEmpty() {
        XCTAssertEqual(FileViewer.splitLines(AttributedString("")).count, 1)
    }

    // MARK: asset frame decode (frozen §5.4.5 shape the /fs/image fetch rides on)

    func testAssetFrameDecodes() throws {
        let bytes = Data([0x89, 0x50, 0x4E, 0x47])   // PNG magic
        let json = #"{"t":"asset","correlationId":"c-1","status":200,"mime":"image/png","bytesB64":"\#(bytes.base64EncodedString())"}"#
        guard case .asset(let a) = try ServerFrame.decode(Data(json.utf8)) else {
            return XCTFail("expected .asset")
        }
        XCTAssertEqual(a.correlationId, "c-1")
        XCTAssertEqual(a.status, 200)
        XCTAssertEqual(a.mime, "image/png")
        XCTAssertEqual(Data(base64Encoded: a.bytesB64), bytes)
    }
}
