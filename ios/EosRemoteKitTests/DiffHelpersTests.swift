import XCTest
@testable import EosRemoteKit

// Port of app/ui/src/lib/diff.test.js (spec 03 §5.8) — LCS, hunk builders, cat-line-number stripping,
// ask-answer parsing. The reusable helpers the Phase-4b Edit/MultiEdit renderer consumes.
final class DiffHelpersTests: XCTestCase {

    private func shape(_ hunks: [DiffHunk]) -> [[String: String]] {
        hunks.map { ["type": $0.type.rawValue, "num": String($0.num), "text": $0.text] }
    }

    // MARK: computeLCS
    func testLCSArrays() { XCTAssertEqual(computeLCS(["a", "b", "c"], ["a", "x", "c"]), ["a", "c"]) }
    func testLCSStrings() { XCTAssertEqual(computeLCS("abcde", "ace"), ["a", "c", "e"]) }
    func testLCSNothingInCommon() { XCTAssertEqual(computeLCS(["a", "b"], ["x", "y"]), []) }
    func testLCSIdentical() { XCTAssertEqual(computeLCS(["a", "b", "c"], ["a", "b", "c"]), ["a", "b", "c"]) }
    func testLCSEmpty() { XCTAssertEqual(computeLCS([], ["a"]), []) }

    // MARK: buildDiffHunks
    func testHunksEmpty() { XCTAssertEqual(buildDiffHunks([], []).count, 0) }
    func testHunksSingleReplace() {
        let hunks = buildDiffHunks(["a", "b", "c"], ["a", "x", "c"])
        XCTAssertEqual(shape(hunks), [
            ["type": "ctx", "num": "1", "text": "a"],
            ["type": "del", "num": "2", "text": "b"],
            ["type": "add", "num": "2", "text": "x"],
            ["type": "ctx", "num": "3", "text": "c"]])
    }
    func testHunksInlineSegments() {
        let hunks = buildDiffHunks(["foo"], ["bar"])
        XCTAssertNotNil(hunks.first { $0.type == .del }?.segments)
        XCTAssertNotNil(hunks.first { $0.type == .add }?.segments)
    }
    func testHunksPureInsertion() {
        let hunks = buildDiffHunks(["a", "b"], ["a", "new", "b"])
        XCTAssertEqual(hunks.map { $0.type.rawValue }, ["ctx", "add", "ctx"])
        XCTAssertEqual(hunks.first { $0.type == .add }?.text, "new")
    }
    func testHunksPureDeletion() {
        let hunks = buildDiffHunks(["a", "gone", "b"], ["a", "b"])
        XCTAssertEqual(hunks.map { $0.type.rawValue }, ["ctx", "del", "ctx"])
        XCTAssertEqual(hunks.first { $0.type == .del }?.text, "gone")
    }

    // MARK: patchToHunks
    private func patch(_ arr: [[String: Any]]) -> JSONValue {
        try! JSONDecoder().decode(JSONValue.self, from: try! JSONSerialization.data(withJSONObject: arr))
    }
    func testPatchAbsoluteNumbers() {
        let hunks = patchToHunks(patch([["oldStart": 35, "newStart": 35, "lines": [" a", "-b", "+x", " c"]]]))
        XCTAssertEqual(shape(hunks), [
            ["type": "ctx", "num": "35", "text": "a"],
            ["type": "del", "num": "36", "text": "b"],
            ["type": "add", "num": "36", "text": "x"],
            ["type": "ctx", "num": "37", "text": "c"]])
    }
    func testPatchInlineSegments() {
        let hunks = patchToHunks(patch([["oldStart": 10, "newStart": 10, "lines": ["-foo", "+bar"]]]))
        XCTAssertNotNil(hunks.first { $0.type == .del }?.segments)
        XCTAssertNotNil(hunks.first { $0.type == .add }?.segments)
    }
    func testPatchRestartsNumberingPerHunk() {
        let hunks = patchToHunks(patch([["oldStart": 1, "newStart": 1, "lines": ["-a", "+A"]],
                                        ["oldStart": 100, "newStart": 100, "lines": ["-z", "+Z"]]]))
        XCTAssertEqual(hunks.map { $0.num }, [1, 1, 100, 100])
    }
    func testPatchSkipsNoNewlineMarker() {
        let hunks = patchToHunks(patch([["oldStart": 5, "newStart": 5, "lines": ["-old", "+new", "\\ No newline at end of file"]]]))
        XCTAssertEqual(hunks.map { $0.type.rawValue }, ["del", "add"])
    }
    func testPatchNonArray() {
        XCTAssertEqual(patchToHunks(.null).count, 0)
        XCTAssertEqual(patchToHunks(nil).count, 0)
    }

    // MARK: parseAskAnswers
    func testAskArrowFormat() {
        let qs = ["What color?", "What size?"]
        let result = "Done.\nMy answers to your questions:\nWhat color? → blue\nWhat size? → large"
        XCTAssertEqual(parseAskAnswers(qs, result), ["blue", "large"])
    }
    func testAskQuotedFormat() {
        let qs = ["What color?", "What size?"]
        let result = "Your questions have been answered: \"What color?\" = \"blue\", \"What size?\" = \"large\"."
        XCTAssertEqual(parseAskAnswers(qs, result), ["blue", "large"])
    }
    func testAskNoTrailingProseLeak() {
        let qs = ["Dağıtım?", "Model?", "Bildirim?"]
        let result = "Your questions have been answered: \"Dağıtım?\"=\"Paralel worker\", \"Model?\"=\"Haiku\", \"Bildirim?\"=\"geber\". You can now continue with these answers in mind."
        XCTAssertEqual(parseAskAnswers(qs, result), ["Paralel worker", "Haiku", "geber"])
    }
    func testAskMultiSelectComma() {
        let result = "Your questions have been answered: \"Pick fruits\"=\"Apple, Cherry\". You can now continue with these answers in mind."
        XCTAssertEqual(parseAskAnswers(["Pick fruits"], result), ["Apple, Cherry"])
    }
    func testAskSubstringFallback() {
        let result = "My answers to your questions:\nWhich database → postgres"
        XCTAssertEqual(parseAskAnswers(["Which database should we use for storage?"], result), ["postgres"])
    }
    func testAskNilForUnmatched() {
        XCTAssertEqual(parseAskAnswers(["Unrelated?"], "My answers to your questions:\nSomething else → foo"), [nil])
    }
    func testAskEmptyResult() { XCTAssertEqual(parseAskAnswers(["x"], ""), []) }
    func testAskEmptyQuestions() { XCTAssertEqual(parseAskAnswers([], "anything"), []) }

    // MARK: stripCatLineNumbers
    func testStripCatNumbers() {
        let text = "     1\tconst x = 1;\n     2\tconst y = 2;"
        XCTAssertEqual(stripCatLineNumbers(text), [PreviewLine(num: 1, text: "const x = 1;"), PreviewLine(num: 2, text: "const y = 2;")])
    }
    func testStripSequentialFallback() {
        XCTAssertEqual(stripCatLineNumbers("line one\nline two"), [PreviewLine(num: 1, text: "line one"), PreviewLine(num: 2, text: "line two")])
    }
    func testStripEmpty() { XCTAssertEqual(stripCatLineNumbers(""), []) }
}
