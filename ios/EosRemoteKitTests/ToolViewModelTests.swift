import XCTest
@testable import EosRemoteKit

// Coverage for the pure tool-chrome helpers (spec 03 §2/§5.3) the Phase-4b ToolItemView/registry
// consume: diff-stat counts (the +add/-del header chip), the git-aware Bash label, the FALLBACK
// "Used {name}" humanizer + argsSummary hint.
final class ToolViewModelTests: XCTestCase {

    private func tool(_ name: String, input: [String: JSONValue], result: ToolResult? = nil) -> Tool {
        Tool(id: "x", name: name, verb: verbFor(name), input: .object(input),
             result: result, running: false, done: true, ts: 0)
    }
    private func json(_ arr: [[String: Any]]) -> JSONValue {
        try! JSONDecoder().decode(JSONValue.self, from: try! JSONSerialization.data(withJSONObject: arr))
    }

    // MARK: editDiffStats

    func testEditStatsFromStrings() {
        let t = tool("Edit", input: ["old_string": .string("a\nb\nc"), "new_string": .string("a\nX\nc")])
        let stats = editDiffStats(t)
        XCTAssertEqual(stats?.add, 1)
        XCTAssertEqual(stats?.del, 1)
    }

    func testEditStatsPrefersPatch() {
        let patch = json([["oldStart": 1, "newStart": 1, "lines": [" a", "-b", "+x", "+y", " c"]]])
        let t = tool("Edit", input: ["old_string": .string("ignored"), "new_string": .string("ignored")],
                     result: ToolResult(text: "", isError: false, patch: patch))
        let stats = editDiffStats(t)
        XCTAssertEqual(stats?.add, 2)
        XCTAssertEqual(stats?.del, 1)
    }

    func testEditStatsNilWhenNoChange() {
        XCTAssertNil(editDiffStats(tool("Edit", input: ["old_string": .string("same"), "new_string": .string("same")])))
    }

    func testMultiEditStatsSumsEdits() {
        let edits: JSONValue = .array([
            .object(["old_string": .string("a"), "new_string": .string("A")]),
            .object(["old_string": .string("b\nc"), "new_string": .string("B\nc")]),
        ])
        let stats = multiEditDiffStats(tool("MultiEdit", input: ["edits": edits]))
        XCTAssertEqual(stats?.add, 2)
        XCTAssertEqual(stats?.del, 2)
    }

    // MARK: bashLabel (git-aware)

    func testBashLabelPlainCommand() {
        XCTAssertEqual(bashLabel(tool("Bash", input: ["command": .string("ls -la")])), "Ran ls -la")
    }
    func testBashLabelClampsLongCommand() {
        let long = String(repeating: "x", count: 80)
        XCTAssertTrue(bashLabel(tool("Bash", input: ["command": .string(long)])).hasSuffix("…"))
    }
    func testBashLabelGitPush() {
        XCTAssertEqual(bashLabel(tool("Bash", input: ["command": .string("git push origin dev")])), "Pushed origin dev")
    }
    func testBashLabelCommitSha() {
        let t = tool("Bash", input: ["command": .string("git commit -m \"x\"")],
                     result: ToolResult(text: "[dev fbce36a] x\n 1 file changed", isError: false, patch: nil))
        XCTAssertEqual(bashLabel(t), "Committed fbce36a")
    }

    // MARK: humanizeToolName + argsSummary (FALLBACK)

    func testHumanizeMcpName() {
        XCTAssertEqual(humanizeToolName("mcp__orchestrator__spawn_worker"), "spawn worker")
    }
    func testHumanizePlainName() {
        XCTAssertEqual(humanizeToolName("SomeTool"), "SomeTool")
    }
    func testArgsSummaryPrefersDescriptiveKey() {
        XCTAssertEqual(argsSummary(.object(["mode": .string("deep"), "query": .string("widgets")])), "widgets")
    }
    func testArgsSummaryFallsBackToFirstScalar() {
        XCTAssertEqual(argsSummary(.object(["alpha": .string("first")])), "first")
    }
    func testArgsSummaryNilWhenEmpty() {
        XCTAssertNil(argsSummary(.object([:])))
    }
    func testArgsSummaryCollapsesNewlines() {
        XCTAssertEqual(argsSummary(.object(["prompt": .string("line one\nline two")])), "line one line two")
    }
}
