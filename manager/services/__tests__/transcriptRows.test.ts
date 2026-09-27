import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { transcriptView } from "../pty/transcriptRows.ts";

// Transcript lines in Claude Code's JSONL shape (subset the mapper reads).
let n = 0;
const T = "2026-09-27T10:00:00.000Z";
function line(e: Record<string, unknown>): Record<string, unknown> {
  return { uuid: `u${++n}`, timestamp: T, isSidechain: false, ...e };
}
const user = (parent: string | null, content: unknown, extra = {}) =>
  line({ type: "user", parentUuid: parent, message: { role: "user", content }, ...extra });
const assistant = (parent: string, content: unknown[], stop: string | null) =>
  line({ type: "assistant", parentUuid: parent, message: { role: "assistant", content, stop_reason: stop } });
const jsonl = (entries: Record<string, unknown>[]) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n";

const ask = { questions: [{ header: "Color", question: "Which?", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] }] };

describe("transcriptView", () => {
  it("maps prompts, assistant blocks and tool results to worker-event rows keyed by line", () => {
    const u = user(null, "hello");
    const a1 = assistant(u.uuid as string, [{ type: "thinking", thinking: "hmm" }], "tool_use");
    const a2 = assistant(a1.uuid as string, [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }], "tool_use");
    const r = user(a2.uuid as string, [{ type: "tool_result", tool_use_id: "t1", content: "file body" }]);
    const a3 = assistant(r.uuid as string, [{ type: "text", text: "done" }], "end_turn");
    const v = transcriptView(jsonl([{ type: "mode" }, u, a1, a2, r, a3]));

    assert.deepEqual(v.rows.map((x) => [x.id, x.type]), [[2, "user_message"], [3, "agent_event"], [4, "agent_event"], [5, "agent_event"], [6, "agent_event"]]);
    assert.deepEqual(v.rows[0].payload, { text: "hello" });
    assert.equal(v.rows[0].ts, Date.parse(T));
    assert.deepEqual((v.rows[1].payload as { blocks: unknown[] }).blocks, [{ type: "reasoning", text: "hmm", blockId: `${a1.uuid}:0` }]);
    assert.deepEqual(v.rows[3].payload, { type: "message", role: "tool", blocks: [{ type: "tool_result", callId: "t1", isError: false, content: "file body" }] });
    assert.equal(v.running, false);
    assert.equal(v.pending, null);
  });

  it("is running until the turn ends", () => {
    const u = user(null, "go");
    assert.equal(transcriptView(jsonl([u])).running, true);
    const a = assistant(u.uuid as string, [{ type: "text", text: "partial" }], null);
    assert.equal(transcriptView(jsonl([u, a])).running, true);
    const end = line({ type: "system", subtype: "turn_duration", parentUuid: a.uuid });
    assert.equal(transcriptView(jsonl([u, a, end])).running, false);
  });

  it("reports an unanswered AskUserQuestion as pending until its result lands", () => {
    const u = user(null, "ask me");
    const a = assistant(u.uuid as string, [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: ask }], "tool_use");
    assert.deepEqual(transcriptView(jsonl([u, a])).pending, { toolUseId: "q1", name: "AskUserQuestion", input: ask });
    const r = user(a.uuid as string, [{ type: "tool_result", tool_use_id: "q1", content: "answered" }]);
    assert.equal(transcriptView(jsonl([u, a, r])).pending, null);
  });

  it("drops a pending dialog on interrupt and marks the turn aborted", () => {
    const u = user(null, "plan it");
    const a = assistant(u.uuid as string, [{ type: "tool_use", id: "p1", name: "ExitPlanMode", input: { plan: "x" } }], "tool_use");
    const i = user(a.uuid as string, [{ type: "text", text: "[Request interrupted by user]" }]);
    const v = transcriptView(jsonl([u, a, i]));
    assert.equal(v.pending, null);
    assert.equal(v.running, false);
    assert.deepEqual(v.rows.at(-1)?.payload, { type: "turn", phase: "aborted" });
  });

  it("shows slash commands as typed and hides harness chatter", () => {
    const c = user(null, "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>");
    const out = user(c.uuid as string, "<local-command-stdout>Set model</local-command-stdout>");
    const meta = user(out.uuid as string, "caveat", { isMeta: true });
    const v = transcriptView(jsonl([c, out, meta]));
    assert.deepEqual(v.rows.map((x) => x.payload), [{ text: "/model opus" }]);
  });

  it("unwraps a pasted prompt", () => {
    const u = user(null, '\n\n<pasted_content id="a8cd">\nline one\nline two\n</pasted_content id="a8cd">\n');
    assert.deepEqual(transcriptView(jsonl([u])).rows[0].payload, { text: "line one\nline two" });
  });

  it("shows only the active branch after a rewind", () => {
    const u = user(null, "first");
    const old = assistant(u.uuid as string, [{ type: "text", text: "abandoned" }], "end_turn");
    const retry = user(null, "second");
    const v = transcriptView(jsonl([u, old, retry]));
    assert.deepEqual(v.rows.map((x) => [x.id, x.payload]), [[3, { text: "second" }]]);
  });
});
