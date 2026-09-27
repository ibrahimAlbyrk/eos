import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderTranscript, type TranscriptEntry } from "../domain/transcript.ts";
import { parseClaudeTranscript } from "../domain/claude-transcript.ts";
import { estimateTokens, extractSummary, isCompactionDue, transcriptCharBudget } from "../domain/compaction.ts";

const line = (o: Record<string, unknown>): string => JSON.stringify(o);

describe("parseClaudeTranscript", () => {
  it("reads the active branch as user/assistant/tool entries, dropping thinking and harness noise", () => {
    const jsonl = [
      line({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "fix the auth bug" } }),
      line({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } }),
      line({ type: "assistant", uuid: "a2", parentUuid: "a1", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "auth.ts" } }] } }),
      line({ type: "user", uuid: "u2", parentUuid: "a2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "export const x = 1" }], is_error: false }] } }),
      line({ type: "assistant", uuid: "a3", parentUuid: "u2", message: { role: "assistant", content: [{ type: "text", text: "Found it." }] } }),
      line({ type: "user", uuid: "u3", parentUuid: "a3", message: { role: "user", content: "[Request interrupted by user]" } }),
      line({ type: "user", uuid: "u4", parentUuid: "u3", isMeta: true, message: { role: "user", content: "meta caveat" } }),
      line({ type: "user", uuid: "u5", parentUuid: "u4", message: { role: "user", content: [{ type: "text", text: "now add a test" }] } }),
    ].join("\n");
    assert.deepEqual(parseClaudeTranscript(jsonl), [
      { kind: "user", text: "fix the auth bug" },
      { kind: "tool_call", name: "Read", input: '{"file_path":"auth.ts"}' },
      { kind: "tool_result", text: "export const x = 1", isError: false },
      { kind: "assistant", text: "Found it." },
      { kind: "user", text: "now add a test" },
    ]);
  });

  it("ignores abandoned (rewound) branches and sidechains", () => {
    const jsonl = [
      line({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "first" } }),
      line({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "old answer" }] } }),
      line({ type: "assistant", uuid: "s1", parentUuid: "u1", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent" }] } }),
      line({ type: "assistant", uuid: "a2", parentUuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "new answer" }] } }),
      "{torn",
    ].join("\n");
    assert.deepEqual(parseClaudeTranscript(jsonl), [
      { kind: "user", text: "first" },
      { kind: "assistant", text: "new answer" },
    ]);
  });
});

describe("renderTranscript", () => {
  const entries: TranscriptEntry[] = [
    { kind: "user", text: "task" },
    { kind: "assistant", text: "on it" },
    { kind: "tool_call", name: "Bash", input: "x".repeat(50) },
    { kind: "tool_result", text: "boom", isError: true },
    { kind: "user", text: "next" },
  ];

  it("renders labelled blocks, clips tool I/O and counts user turns", () => {
    const r = renderTranscript(entries, { maxChars: 10_000, toolInputChars: 10 });
    assert.equal(r.turns, 2);
    assert.equal(r.omitted, 0);
    assert.match(r.text, /^\[user\]\ntask\n\n\[assistant\]\non it/);
    assert.match(r.text, /\[tool call: Bash\]\nxxxxxxxxxx… \[40 more chars\]/);
    assert.match(r.text, /\[tool result \(error\)\]\nboom/);
  });

  it("drops the oldest entries to fit, always keeping the first user message", () => {
    const r = renderTranscript(entries, { maxChars: 60, toolInputChars: 10 });
    assert.ok(r.omitted > 0);
    assert.ok(r.text.startsWith("[user]\ntask"), "the task statement survives");
    assert.match(r.text, /earlier entries omitted/);
    assert.ok(r.text.endsWith("[user]\nnext"), "the most recent work survives");
  });
});

describe("compaction decisions", () => {
  it("is due only when enabled and at/over the threshold of a known window", () => {
    assert.equal(isCompactionDue({ enabled: true, threshold: 0.7, used: 140_000, limit: 200_000 }), true);
    assert.equal(isCompactionDue({ enabled: true, threshold: 0.7, used: 138_000, limit: 200_000 }), false);
    assert.equal(isCompactionDue({ enabled: false, threshold: 0.7, used: 190_000, limit: 200_000 }), false);
    assert.equal(isCompactionDue({ enabled: true, threshold: 0.7, used: 190_000, limit: null }), false);
    assert.equal(isCompactionDue({ enabled: true, threshold: 0.7, used: 0, limit: 200_000 }), false);
  });

  it("keeps only the <summary> block, falling back to the answer minus its analysis", () => {
    assert.equal(extractSummary("<analysis>think</analysis>\n<summary>\n1. Task\n</summary>"), "1. Task");
    assert.equal(extractSummary("<analysis>think</analysis>\nplain summary"), "plain summary");
    assert.equal(extractSummary("<summary>a</summary> <summary>b</summary>"), "b");
  });

  it("budgets the transcript from the summarizer's window", () => {
    assert.equal(transcriptCharBudget(200_000), 420_000);
    assert.equal(transcriptCharBudget(null), transcriptCharBudget(200_000));
    assert.equal(estimateTokens("1234567"), 2);
  });
});
