import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInProcessBackend, type InProcessEnv } from "../backends/InProcessBackend.ts";
import { JsonlConversationStore } from "../conversation/JsonlConversationStore.ts";
import { randomIdGenerator } from "../id/RandomIdGenerator.ts";
import { reconcileWorkersOnBoot, type ReconcileWorkersOnBootDeps } from "../../../core/src/use-cases/ReconcileWorkersOnBoot.ts";
import type { ModelClient, ModelTurn, ModelMessage } from "../../../core/src/ports/ModelClient.ts";
import type { IdGenerator } from "../../../core/src/ports/IdGenerator.ts";
import type { RuntimeTool, ToolGate } from "../../../core/src/use-cases/ToolRuntime.ts";
import type { AgentEvent, AgentLaunchSpec } from "../../../core/src/ports/AgentBackend.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { WorkerState } from "../../../contracts/src/events.ts";

// M3 durability: an in-process worker (incl. a persistent orchestrator) survives a
// daemon restart — each settled turn is persisted under the session id, boot
// reconcile keeps the row SUSPENDED, and resume rehydrates the conversation. /clear
// resets the FSM and drops the stored conversation. With NO deps, none of this fires
// (conformance stays green — see agent-backend-conformance.test.ts).

interface RecordingModel extends ModelClient {
  seen: ModelMessage[][];
}
function recordingModel(turns: ModelTurn[]): RecordingModel {
  let i = 0;
  const seen: ModelMessage[][] = [];
  return {
    seen,
    async createTurn(messages: ModelMessage[]) {
      seen.push(messages.map((m) => ({ ...m })));
      return turns[Math.min(i++, turns.length - 1)];
    },
  };
}

const allowGate: ToolGate = { async decide() { return { allow: true }; } };

function makeEnv(model: ModelClient): InProcessEnv {
  const tools = new Map<string, RuntimeTool>([
    ["echo", { name: "echo", async execute() { return "echoed"; } }],
  ]);
  return { model, tools, gate: allowGate };
}

// A user turn that drives one echo tool round-trip then ends — so the persisted
// conversation carries a user message + a neutral tool-call + a neutral tool-result.
const toolThenDone = (): ModelTurn[] => [
  { toolCalls: [{ callId: "c1", name: "echo", input: { v: 1 } }], stopReason: "tool_use" },
  { text: "done", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } },
];

function spec(prompt: string, resume?: string): AgentLaunchSpec {
  return {
    workerId: "w1", cwd: "/tmp", model: "fake-model", prompt,
    persistent: true, parentId: null, isOrchestrator: false,
    backendOptions: resume ? { resume } : undefined,
  };
}

function counterIds(): IdGenerator {
  let n = 0;
  return { ...randomIdGenerator, newSessionId: () => `s-test-${++n}` };
}

const readyId = (events: AgentEvent[]): string | undefined => {
  for (const e of events) if (e.type === "session" && e.phase === "ready") return e.sessionId;
  return undefined;
};

function setup(t: { after(fn: () => void): void }): { store: JsonlConversationStore; ids: IdGenerator } {
  const dir = mkdtempSync(join(tmpdir(), "eos-conv-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { store: new JsonlConversationStore(join(dir, "conversations")), ids: counterIds() };
}

// Minimal in-memory WorkerRepo for the boot-reconcile use-case (mirrors the core
// ReconcileWorkersOnBoot suite's fake).
interface RowSeed { id: string; state: WorkerState; session_id?: string | null; cwd?: string | null; }
function reconcileDeps(seeds: RowSeed[], existing: string[]): {
  rows: Map<string, RowSeed>;
  deps: ReconcileWorkersOnBootDeps;
} {
  const rows = new Map(seeds.map((s) => [s.id, { session_id: null, cwd: null, worktree_dir: null, ...s }]));
  const exists = new Set(existing);
  const workers = {
    listAll: () => [...rows.values()] as unknown as WorkerRow[],
    findById: (id: string) => (rows.get(id) ?? null) as unknown as WorkerRow,
    updateState: (id: string, state: WorkerState) => { rows.get(id)!.state = state; },
    setTurnStartedAt: () => {},
    markDone: (id: string) => { rows.get(id)!.state = "DONE"; },
    clearRuntime: () => {},
  } as unknown as ReconcileWorkersOnBootDeps["workers"];
  const deps = {
    workers,
    events: { append: () => 1 },
    bus: { publish: () => {} },
    clock: { now: () => 1 },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pathExists: (p: string) => exists.has(p),
  } as unknown as ReconcileWorkersOnBootDeps;
  return { rows: rows as unknown as Map<string, RowSeed>, deps };
}

describe("InProcessBackend durability (M3)", () => {
  it("survives a daemon restart: persist turn → reconcile SUSPENDED → resume rehydrates", async (t) => {
    const { store, ids } = setup(t);

    // --- daemon run 1: spawn + one turn persists the conversation ---
    const model1 = recordingModel(toolThenDone());
    const events1: AgentEvent[] = [];
    const be1 = createInProcessBackend("anthropic-api", () => makeEnv(model1), { store, ids });
    await be1.start(spec("first task"), { onEvent: (e) => events1.push(e) });
    await be1.whenSettled("w1");

    const sessionId = readyId(events1);
    assert.equal(sessionId, "s-test-1", "start emits session ready with the durable id");

    const stored = store.load(sessionId!);
    assert.ok(stored, "the conversation was persisted after the turn");
    assert.equal(stored!.length, 3);
    assert.deepEqual(stored![0], { role: "user", content: "first task" }); // dialect-neutral

    // --- boot reconcile: the row carries the persisted session_id (setSessionId on
    // the `ready` event in production) + an on-disk cwd → SUSPENDED, not closed ---
    const { rows, deps } = reconcileDeps([{ id: "w1", state: "WORKING", session_id: sessionId, cwd: "/proj" }], ["/proj"]);
    assert.equal(reconcileWorkersOnBoot(deps).suspended, 1);
    assert.equal(rows.get("w1")!.state, "SUSPENDED");

    // --- daemon run 2: a FRESH backend instance (empty live registry). Resume goes
    // through start({backendOptions.resume}) — NOT attach — so store.load seeds it ---
    const model2 = recordingModel([{ text: "resumed", toolCalls: [], stopReason: "end_turn" }]);
    const be2 = createInProcessBackend("anthropic-api", () => makeEnv(model2), { store, ids });
    const session2 = await be2.start(spec("", sessionId), { onEvent: () => {} });
    await be2.whenSettled("w1");
    assert.equal(model2.seen.length, 0, "the empty resume prompt drives no turn");

    // the next turn sees the rehydrated history followed by the new user message
    await session2.sendMessage("second task");
    await be2.whenSettled("w1");
    const seen = model2.seen[0];
    assert.equal(seen.length, 4, "3 rehydrated messages + 1 new user message");
    assert.deepEqual(seen[0], { role: "user", content: "first task" });
    assert.deepEqual(seen[3], { role: "user", content: "second task" });
  });

  it("/clear emits cleared, deletes the stored conversation, and rolls to a fresh session id", async (t) => {
    const { store, ids } = setup(t);
    const events: AgentEvent[] = [];
    const be = createInProcessBackend("anthropic-api", () => makeEnv(recordingModel(toolThenDone())), { store, ids });
    const session = await be.start(spec("first task"), { onEvent: (e) => events.push(e) });
    await be.whenSettled("w1");

    const sessionId = readyId(events)!;
    assert.ok(store.load(sessionId), "persisted before clear");

    events.length = 0;
    await session.clearContext!();

    assert.ok(events.some((e) => e.type === "session" && e.phase === "cleared"), "cleared emitted (FSM reset)");
    assert.equal(store.load(sessionId), null, "stored conversation deleted");
    const fresh = readyId(events);
    assert.ok(fresh, "a fresh session ready was emitted");
    assert.notEqual(fresh, sessionId, "rolled to a new session id");
  });

  it("with NO deps: no session id, no ready event, no persistence (conformance shape)", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "eos-conv-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const events: AgentEvent[] = [];
    const be = createInProcessBackend("anthropic-api", () => makeEnv(recordingModel(toolThenDone())));
    await be.start(spec("first task"), { onEvent: (e) => events.push(e) });
    await be.whenSettled("w1");
    assert.equal(readyId(events), undefined, "no ready event without an id source");
  });
});
