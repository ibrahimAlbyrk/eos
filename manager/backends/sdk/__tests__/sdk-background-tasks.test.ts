// Background shells and Monitors: a Bash run_in_background / Monitor call ->
// onBackgroundTask started; Monitor events (carriers without <status>) ->
// event; task_notification / a carrier with <status> / background_tasks_changed
// -> ended. Never AgentEvents. Result texts and carriers are copied from real
// transcripts (claude-agent-sdk 0.3.284).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "../../../../contracts/src/canonical.ts";
import { createSdkEventMapper, exitCodeOf, type BackgroundTaskUpdate, type SdkEventMapper } from "../SdkEventMapper.ts";

const OUT = "/private/tmp/claude-501/-p/3cad/tasks/b5fq9cqhq.output";

const call = (id: string, name: string, input: Record<string, unknown>) => ({
  type: "assistant",
  uuid: `u-${id}`,
  message: { id: `msg_${id}`, content: [{ type: "tool_use", id, name, input }] },
});
const result = (id: string, text: string, sidecar?: unknown) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] },
  ...(sidecar ? { tool_use_result: sidecar } : {}),
});
const started = (taskId: string, toolUseId: string, extra: Record<string, unknown> = {}) => ({
  type: "system", subtype: "task_started", task_id: taskId, tool_use_id: toolUseId, description: "x", task_type: "local_bash", ...extra,
});
const carrier = (body: string) => ({ type: "user", message: { content: `<task-notification>\n${body}\n</task-notification>` } });

const BASH = call("toolu_b1", "Bash", { command: "npm run dev", description: "Start dev server", run_in_background: true });
const BASH_RESULT = result("toolu_b1", `Command running in background with ID: b5fq9cqhq. Output is being written to: ${OUT}. Use the Read tool to check.`, { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "b5fq9cqhq" });
const MONITOR = call("toolu_m1", "Monitor", { description: "test watcher", command: "tail -f logs/test.log", timeout_ms: 1800000 });
const MONITOR_RESULT = result("toolu_m1", "Monitor started (task b2dq2c61u, expires in 30m).", { taskId: "b2dq2c61u", timeoutMs: 1800000, persistent: false });

function run(msgs: unknown[], mapper?: SdkEventMapper): { updates: BackgroundTaskUpdate[]; events: AgentEvent[]; mapper: SdkEventMapper } {
  const updates: BackgroundTaskUpdate[] = [];
  const m = mapper ?? createSdkEventMapper({ onBackgroundTask: (u) => updates.push(u) });
  const events: AgentEvent[] = [];
  for (const msg of msgs) events.push(...m.map(msg as never));
  return { updates, events, mapper: m };
}

describe("SdkEventMapper — background shells and Monitors", () => {
  it("announces a background Bash once, from task_started, with its output file from the result", () => {
    const { updates, events } = run([BASH, started("b5fq9cqhq", "toolu_b1", { is_backgrounded: true }), BASH_RESULT]);
    assert.deepEqual(updates, [
      { phase: "started", taskId: "b5fq9cqhq", callId: "toolu_b1", kind: "shell", title: "Start dev server", command: "npm run dev", outputFile: null },
      { phase: "output", taskId: "b5fq9cqhq", outputFile: OUT },
    ]);
    assert.ok(!events.some((e) => e.type === "subagent_started"), "a shell is never a subagent");
  });

  it("falls back to the result sidecar when task_started was missed", () => {
    const { updates } = run([BASH, BASH_RESULT]);
    assert.deepEqual(updates, [{ phase: "started", taskId: "b5fq9cqhq", callId: "toolu_b1", kind: "shell", title: "Start dev server", command: "npm run dev", outputFile: OUT }]);
  });

  it("ends a shell from its notification, with the exit code from the summary", () => {
    const { updates } = run([BASH, BASH_RESULT, {
      type: "system", subtype: "task_notification", task_id: "b5fq9cqhq", tool_use_id: "toolu_b1", status: "completed",
      output_file: OUT, summary: `Background command "Start dev server" completed (exit code 0)`,
    }]);
    assert.deepEqual(updates.at(-1), { phase: "ended", taskId: "b5fq9cqhq", status: "completed", summary: `Background command "Start dev server" completed (exit code 0)`, outputFile: OUT, exitCode: 0 });
  });

  it("leaves a foreground Bash alone until it is moved to the background", () => {
    const fg = call("toolu_f1", "Bash", { command: "npm test" });
    const { updates, mapper } = run([fg, started("bf1", "toolu_f1")]);
    assert.deepEqual(updates, []);
    run([{ type: "system", subtype: "task_updated", task_id: "bf1", patch: { is_backgrounded: true } }], mapper);
    assert.deepEqual(updates.map((u) => [u.phase, u.taskId]), [["started", "bf1"]]);
  });

  it("relays a Monitor's events and ends it on the carrier that has a status", () => {
    const { updates } = run([
      MONITOR, MONITOR_RESULT,
      carrier(`<task-id>b2dq2c61u</task-id>\n<summary>Monitor event: "test watcher"</summary>\n<event>12:39:44  FAIL  auth.spec.ts</event>`),
      carrier(`<task-id>b2dq2c61u</task-id>\n<tool-use-id>toolu_m1</tool-use-id>\n<status>completed</status>\n<summary>Monitor "test watcher" stream ended</summary>`),
    ]);
    assert.deepEqual(updates.map((u) => u.phase), ["started", "event", "ended"]);
    assert.equal(updates[0].phase === "started" && updates[0].kind, "monitor");
    assert.equal(updates[0].phase === "started" && updates[0].command, "tail -f logs/test.log");
    assert.equal(updates[1].phase === "event" && updates[1].text, "12:39:44  FAIL  auth.spec.ts");
  });

  it("ends a shell that left the live task set without a notification", () => {
    const { updates } = run([BASH, BASH_RESULT, { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "other", task_type: "local_agent", description: "y" }] }]);
    assert.equal(updates.at(-1)?.phase, "ended");
  });

  it("reports live shells as stopped when the process goes away, once", () => {
    const { updates, mapper } = run([BASH, BASH_RESULT]);
    mapper.stopLiveSubagents();
    mapper.stopLiveSubagents();
    assert.deepEqual(updates.filter((u) => u.phase === "ended").map((u) => u.phase === "ended" && u.status), ["stopped"]);
  });

  it("ignores an ambient task and a Bash that isn't one of this session's calls", () => {
    const { updates } = run([BASH, started("b5fq9cqhq", "toolu_b1", { ambient: true }), started("bx", "toolu_unknown", { is_backgrounded: true })]);
    assert.deepEqual(updates, []);
  });

  it("names only Claude Code's own task files as output", () => {
    const bash = call("toolu_b2", "Bash", { command: "x", run_in_background: true });
    const { updates } = run([bash, result("toolu_b2", "Command running in background with ID: b2. Output is being written to: /etc/passwd. done", { backgroundTaskId: "b2" })]);
    assert.equal(updates[0].phase === "started" && updates[0].outputFile, null);
  });

  it("parses exit codes", () => {
    assert.equal(exitCodeOf("Background command \"x\" failed (exit code 101)"), 101);
    assert.equal(exitCodeOf("Monitor stream ended"), null);
    assert.equal(exitCodeOf(undefined), null);
  });
});
