import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSlashCommandRegistry,
  parseSlash,
  type SlashSideEffects,
  type SlashCommandContext,
} from "../domain/slash-command.ts";
import { clearCommand } from "../domain/commands/clear.ts";
import { compactCommand } from "../domain/commands/compact.ts";
import { dispatchMessage, type DispatchMessageDeps } from "../use-cases/DispatchMessage.ts";
import type { AgentBackend, AgentSession, AgentCapabilities } from "../ports/AgentBackend.ts";
import type { MessageRecord } from "../ports/WorkerClient.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import { fakeQueue } from "./helpers/fakeMessageQueue.ts";

const registry = createSlashCommandRegistry([clearCommand, compactCommand]);

describe("parseSlash — exact-allowlist matching", () => {
  it("matches a registered command and splits args", () => {
    assert.deepEqual(parseSlash("/clear", registry)?.command.name, "clear");
    assert.equal(parseSlash("/clear", registry)?.args, "");
    assert.equal(parseSlash("/clear  ", registry)?.args, ""); // trailing ws trimmed
    assert.equal(parseSlash("  /clear", registry)?.args, ""); // leading ws trimmed
    assert.equal(parseSlash("/clear foo bar", registry)?.args, "foo bar");
  });

  it("returns null for plain text, partial, and unknown commands (they flow as normal messages)", () => {
    assert.equal(parseSlash("hello", registry), null);
    assert.equal(parseSlash("/cle", registry), null);       // partial
    assert.equal(parseSlash("/clearx", registry), null);    // not an exact name
    assert.equal(parseSlash("/context", registry), null);   // claude-native, not Eos-owned
    assert.equal(parseSlash("/", registry), null);          // empty name
    assert.equal(parseSlash("not /clear", registry), null); // slash not at start
  });
});

describe("compactCommand", () => {
  const caps = (over: Partial<AgentCapabilities> = {}): AgentCapabilities =>
    ({ interrupt: true, keystroke: false, rewind: false, runtimeModelSwitch: false, runtimePermissionSwitch: false, ...over });
  const ctxWith = (startCompaction: SlashSideEffects["startCompaction"], args = ""): SlashCommandContext => ({
    workerId: "w1", args, session: {} as AgentSession, caps: caps({ contextCompaction: true }),
    services: { clearPendingQueue: () => 0, cancelPeerRequests: () => {}, appendConversationCleared: () => {}, startCompaction },
  });

  it("parses with free-text focus instructions", () => {
    assert.equal(parseSlash("/compact", registry)?.command.name, "compact");
    assert.equal(parseSlash("/compact keep the test output", registry)?.args, "keep the test output");
  });

  it("accepts any args, but only on a compaction-capable backend", () => {
    assert.equal(compactCommand.accepts("", caps({ contextCompaction: true })), true);
    assert.equal(compactCommand.accepts("focus on the API", caps({ contextCompaction: true })), true);
    assert.equal(compactCommand.accepts("", caps({ contextClear: true })), false);
    assert.equal(compactCommand.accepts("", caps()), false);
  });

  it("starts the background run with the instructions and answers 202", async () => {
    const started: Array<[string, string]> = [];
    const r = await compactCommand.execute(ctxWith((id, instr) => { started.push([id, instr]); return { ok: true }; }, "keep the diff"));
    assert.deepEqual(started, [["w1", "keep the diff"]]);
    assert.deepEqual(r, { status: 202, body: { ok: true, compacting: true } });
  });

  it("reports a refused start as 409 with the reason", async () => {
    const r = await compactCommand.execute(ctxWith(() => ({ ok: false, reason: "a compaction is already running" })));
    assert.deepEqual(r, { status: 409, body: { ok: false, error: "a compaction is already running" } });
  });
});

describe("clearCommand", () => {
  const caps = (over: Partial<AgentCapabilities> = {}): AgentCapabilities =>
    ({ interrupt: true, keystroke: false, rewind: false, runtimeModelSwitch: false, runtimePermissionSwitch: false, ...over });

  it("accepts only no-arg invocations on a context-clear-capable backend", () => {
    assert.equal(clearCommand.accepts("", caps({ contextClear: true })), true);
    assert.equal(clearCommand.accepts("foo", caps({ contextClear: true })), false); // takes no args
    assert.equal(clearCommand.accepts("", caps({ contextClear: false })), false);   // incapable
    assert.equal(clearCommand.accepts("", caps()), false);                          // flag absent
  });

  it("resets context and runs all side effects, returning cleared", async () => {
    const calls: string[] = [];
    const services: SlashSideEffects = {
      clearPendingQueue: (id) => { calls.push(`queue:${id}`); return 2; },
      cancelPeerRequests: (id) => { calls.push(`peers:${id}`); },
      appendConversationCleared: (id) => { calls.push(`cleared:${id}`); },
      startCompaction: () => ({ ok: true }),
    };
    let cleared = 0;
    const session = { clearContext: async () => { cleared++; return { ok: true }; } } as unknown as AgentSession;
    const ctx: SlashCommandContext = { workerId: "w1", args: "", session, caps: caps({ contextClear: true }), services };

    const r = await clearCommand.execute(ctx);
    assert.equal(cleared, 1);
    assert.deepEqual(calls, ["queue:w1", "peers:w1", "cleared:w1"]);
    assert.deepEqual(r, { status: 200, body: { ok: true, cleared: true } });
  });
});

// --- dispatchMessage interception (the chokepoint) -------------------------

interface Harness {
  deps: DispatchMessageDeps;
  events: Array<{ type: string }>;
  sends: string[];
  clears: number;
  effects: string[];
}

function harness(opts: { state?: string; contextClear?: boolean; contextCompaction?: boolean } = {}): Harness {
  const events: Array<{ type: string }> = [];
  const sends: string[] = [];
  const effects: string[] = [];
  let clears = 0;
  const queue = fakeQueue();
  const row = { id: "w1", state: opts.state ?? "IDLE", port: 7501, pid: 42, backend_kind: "fake", is_orchestrator: 0 };

  const session = {
    workerId: "w1",
    handle: { kind: "http", port: 7501, pid: 42 },
    capabilities: { interrupt: true, keystroke: true, rewind: true, runtimeModelSwitch: false, runtimePermissionSwitch: false, reportsMessageEvents: true, contextClear: opts.contextClear ?? true, contextCompaction: opts.contextCompaction ?? true },
    sendMessage: async (text: string) => { sends.push(text); return { ok: true, status: 200, body: { ok: true } }; },
    clearContext: async () => { clears++; return { ok: true }; },
  } as unknown as AgentSession;
  const backend = {
    kind: "fake",
    descriptor: { processModel: "out-of-process" },
    start: async () => session,
    attach: () => session,
  } as unknown as AgentBackend;

  const deps = {
    workers: { findById: () => row as unknown as WorkerRow, updateState: () => {}, setTurnStartedAt: () => {} },
    events: { append: (_id: string, _ts: number, type: string) => { events.push({ type }); return events.length; } },
    bus: { publish: () => {} },
    clock: { now: () => 1000 },
    queue: queue.repo,
    client: { sendMessage: async (_p: number, text: string) => { sends.push(text); return { ok: true, status: 200, body: {} }; } },
    backends: { has: (k: string) => k === "fake", get: () => backend },
    slashCommands: registry,
    slashEffects: {
      clearPendingQueue: (id: string) => { effects.push(`queue:${id}`); return 0; },
      cancelPeerRequests: (id: string) => { effects.push(`peers:${id}`); },
      appendConversationCleared: (id: string) => { effects.push(`cleared:${id}`); },
      startCompaction: (id: string, instructions: string) => { effects.push(`compact:${id}:${instructions}`); return { ok: true }; },
    } satisfies SlashSideEffects,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    isLive: () => true,
    clearTurnSettle: () => {},
  } as unknown as DispatchMessageDeps;

  return { deps, events, sends, get clears() { return clears; }, effects };
}

describe("dispatchMessage — slash interception", () => {
  it("runs /clear as a command: clearContext + side effects, no turn, no chat event", async () => {
    const h = harness();
    const r = await dispatchMessage(h.deps, { workerId: "w1", text: "/clear", origin: "dashboard" });
    assert.equal(h.clears, 1, "clearContext invoked");
    assert.deepEqual(h.sends, [], "no message turn dispatched");
    assert.deepEqual(h.events.filter((e) => e.type === "user_message"), [], "no user_message bubble for the command");
    assert.deepEqual(h.effects, ["queue:w1", "peers:w1", "cleared:w1"]);
    assert.deepEqual(r.body, { ok: true, cleared: true });
  });

  it("a plain message is NOT intercepted (normal turn dispatched)", async () => {
    const h = harness();
    await dispatchMessage(h.deps, { workerId: "w1", text: "hello there", origin: "dashboard" });
    assert.equal(h.clears, 0);
    assert.deepEqual(h.sends, ["hello there"]);
    assert.deepEqual(h.effects, []);
  });

  it("an incapable backend falls through: /clear flows as literal text", async () => {
    const h = harness({ contextClear: false });
    await dispatchMessage(h.deps, { workerId: "w1", text: "/clear", origin: "dashboard" });
    assert.equal(h.clears, 0, "clearContext never called when accepts() is false");
    assert.deepEqual(h.sends, ["/clear"], "text delivered as a normal message");
  });

  it("runs /compact as a command: starts compaction with its instructions, no turn, no chat event", async () => {
    const h = harness();
    const r = await dispatchMessage(h.deps, { workerId: "w1", text: "/compact focus on auth", origin: "dashboard" });
    assert.deepEqual(h.effects, ["compact:w1:focus on auth"]);
    assert.deepEqual(h.sends, [], "no message turn dispatched");
    assert.deepEqual(h.events.filter((e) => e.type === "user_message"), []);
    assert.equal(r.status, 202);
  });

  it("an incapable backend falls through: /compact flows on as a normal message", async () => {
    const h = harness({ contextCompaction: false });
    await dispatchMessage(h.deps, { workerId: "w1", text: "/compact", origin: "dashboard" });
    assert.deepEqual(h.effects, []);
    assert.deepEqual(h.sends, ["/compact"]);
  });

  it("/clear sent to a WORKING worker queues instead of intercepting", async () => {
    const h = harness({ state: "WORKING" });
    const r = await dispatchMessage(h.deps, { workerId: "w1", text: "/clear", queueWhenBusy: true, clientMsgId: "c1", origin: "dashboard" });
    assert.equal(h.clears, 0, "queued, not run, while busy");
    assert.equal((r.body as { queued?: boolean }).queued, true);
  });
});
