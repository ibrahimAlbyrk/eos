// Compaction reads a visual answer as one line — its title and summary — instead
// of up to 2000 clipped characters of spec JSON.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeTranscript } from "../domain/claude-transcript.ts";
import { renderTranscript } from "../domain/transcript.ts";

const line = (o: Record<string, unknown>): string => JSON.stringify(o);
const call = (uuid: string, parentUuid: string, name: string, input: unknown): string =>
  line({ type: "assistant", uuid, parentUuid, message: { role: "assistant", content: [{ type: "tool_use", id: `t-${uuid}`, name, input }] } });

describe("parseClaudeTranscript — visual answers", () => {
  it("renders present and present_app calls as [view] title — summary", () => {
    const spec = {
      title: "Kadıköy tonight",
      tone: "blue",
      data: { places: Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, type: "Place", name: `Place ${i}` })) },
      ui: '<Map of="places"/>',
      summary: "6 places open tonight. Best: Moda Kıyı.",
    };
    const jsonl = [
      line({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "where to eat?" } }),
      call("a1", "u1", "mcp__orchestrator__present", spec),
      call("a2", "a1", "mcp__worker__present_app", { title: "Brew timer", html: "<html>…</html>", summary: "A pour-over timer." }),
      call("a3", "a2", "mcp__orchestrator__present", { title: "No summary yet" }),
      call("a4", "a3", "mcp__orchestrator__presentation_helper", { title: "not a view", summary: "x" }),
      call("a5", "a4", "mcp__slides__present", { title: "a user server's tool", summary: "y" }),
    ].join("\n");
    const entries = parseClaudeTranscript(jsonl);
    assert.deepEqual(entries.slice(1), [
      { kind: "tool_call", name: "mcp__orchestrator__present", input: "[view] Kadıköy tonight — 6 places open tonight. Best: Moda Kıyı." },
      { kind: "tool_call", name: "mcp__worker__present_app", input: "[view] Brew timer — A pour-over timer." },
      { kind: "tool_call", name: "mcp__orchestrator__present", input: "[view] No summary yet" },
      { kind: "tool_call", name: "mcp__orchestrator__presentation_helper", input: '{"title":"not a view","summary":"x"}' },
      { kind: "tool_call", name: "mcp__slides__present", input: '{"title":"a user server\'s tool","summary":"y"}' },
    ]);
    const text = renderTranscript(entries, { maxChars: 100_000 }).text;
    assert.match(text, /\[tool call: mcp__orchestrator__present\]\n\[view\] Kadıköy tonight — 6 places/);
    assert.doesNotMatch(text, /Place 39/);
  });

  it("falls back to the JSON when the input carries neither title nor summary", () => {
    const jsonl = [
      line({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "hi" } }),
      call("a1", "u1", "mcp__orchestrator__present", { ui: "<Text>x</Text>" }),
    ].join("\n");
    assert.deepEqual(parseClaudeTranscript(jsonl)[1], { kind: "tool_call", name: "mcp__orchestrator__present", input: '{"ui":"<Text>x</Text>"}' });
  });
});
