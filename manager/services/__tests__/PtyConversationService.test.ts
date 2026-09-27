import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryEventBus } from "../../../infra/src/eventbus/InMemoryEventBus.ts";
import type { EventBusMessage } from "../../../core/src/ports/EventBus.ts";
import type { PtyPending, PtySession } from "../../../contracts/src/http.ts";
import { PtyConversationService } from "../PtyConversationService.ts";

const SID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "pty-conv-"));
  const bus = createInMemoryEventBus();
  const events: EventBusMessage[] = [];
  bus.subscribe("pty:conversation", (m) => events.push(m));
  const session: PtySession = {
    sessionId: "p1", number: 1, cwd: "/proj", cols: 80, rows: 24, alive: true,
    kind: "claude", claudeSessionId: SID_A, title: null, remote: false,
  };
  let dialog: (PtyPending & { at: number }) | null = null;
  const watches = new Map<string, () => void>();
  const stopped: string[] = [];
  const svc = new PtyConversationService({
    bus,
    sessions: { get: (id) => (id === session.sessionId ? session : null), dialogCall: () => dialog },
    transcriptPath: (_cwd, id) => join(dir, `${id}.jsonl`),
    watch: (path, onChange) => { watches.set(path, onChange); return () => { stopped.push(path); watches.delete(path); }; },
  });
  const prompt = (text: string, uuid: string, parentUuid: string | null = null) =>
    JSON.stringify({ type: "user", uuid, parentUuid, timestamp: "2026-09-27T10:00:00Z", message: { role: "user", content: text } }) + "\n";
  const reportDialog = (d: typeof dialog) => { dialog = d; };
  return { dir, bus, events, session, watches, stopped, svc, prompt, reportDialog };
}

describe("PtyConversationService", () => {
  it("reads a claude pane's transcript and re-reads it once the file changes", () => {
    const { dir, svc, prompt } = harness();
    assert.deepEqual(svc.get("p1"), { rows: [], running: false, pending: null, claudeSessionId: SID_A });
    const file = join(dir, `${SID_A}.jsonl`);
    writeFileSync(file, prompt("hi", "u1"));
    assert.deepEqual(svc.get("p1")?.rows.map((r) => r.payload), [{ text: "hi" }]);
    appendFileSync(file, prompt("again", "u2", "u1"));
    assert.deepEqual(svc.get("p1")?.rows.map((r) => r.payload), [{ text: "hi" }, { text: "again" }]);
    assert.equal(svc.get("nope"), null);
  });

  it("publishes pty:conversation when the watched file changes", () => {
    const { dir, svc, watches, events } = harness();
    svc.get("p1");
    watches.get(join(dir, `${SID_A}.jsonl`))!();
    assert.deepEqual(events.map((e) => e.payload), [{ sessionId: "p1", claudeSessionId: SID_A }]);
  });

  it("follows the pane to a new conversation and stops watching when it exits", () => {
    const { dir, bus, svc, session, stopped, events } = harness();
    svc.get("p1");
    session.claudeSessionId = SID_B;
    bus.publish("pty:session", { ...session });
    assert.deepEqual(stopped, [join(dir, `${SID_A}.jsonl`)]);
    assert.deepEqual(events.map((e) => e.payload), [{ sessionId: "p1", claudeSessionId: SID_B }]);
    assert.equal(svc.get("p1")?.claudeSessionId, SID_B);
    bus.publish("pty:exit", { sessionId: "p1", number: 1, exitCode: 0 });
    assert.deepEqual(stopped, [join(dir, `${SID_A}.jsonl`), join(dir, `${SID_B}.jsonl`)]);
  });

  it("shows a reported question the transcript doesn't have yet, until it settles", () => {
    const { dir, svc, prompt, reportDialog } = harness();
    const file = join(dir, `${SID_A}.jsonl`);
    writeFileSync(file, prompt("ask me", "u1"));
    const ask = { toolUseId: "q1", name: "AskUserQuestion" as const, input: { questions: [] } };
    reportDialog({ ...ask, at: Date.parse("2026-09-27T10:00:05Z") });
    assert.deepEqual(svc.get("p1")?.pending, ask);
    const result = JSON.stringify({
      type: "user", uuid: "u2", parentUuid: "u1", timestamp: "2026-09-27T10:00:09Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "q1", content: "answered" }] },
    }) + "\n";
    appendFileSync(file, result);
    assert.equal(svc.get("p1")?.pending, null);
    // …or a later prompt / interrupt settles it (the user cancelled, then moved on).
    reportDialog({ ...ask, toolUseId: "q2", at: Date.parse("2026-09-27T10:00:10Z") });
    appendFileSync(file, prompt("never mind", "u3", "u2").replace("10:00:00", "10:00:12"));
    assert.equal(svc.get("p1")?.pending, null);
  });

  it("has no conversation for a shell pane", () => {
    const { svc, session } = harness();
    session.kind = "shell";
    assert.equal(svc.get("p1"), null);
  });
});
