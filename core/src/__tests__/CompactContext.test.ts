import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compactContext, type CompactContextDeps } from "../use-cases/CompactContext.ts";
import type { AgentBackend, AgentSession } from "../ports/AgentBackend.ts";
import type { SummarizeInput } from "../ports/ConversationSummarizer.ts";
import type { SessionTranscript } from "../domain/transcript.ts";

interface Harness {
  deps: CompactContextDeps;
  row: { id: string; state: string; model: string; backend_kind: string; last_context_tokens: number };
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  states: string[];
  seeds: string[];
  summarizeCalls: SummarizeInput[];
  rearmed: string[];
}

function harness(opts: {
  summary?: () => Promise<string>;
  transcript?: SessionTranscript | null;
  capable?: boolean;
  onSummarize?: (h: Harness) => void;
} = {}): Harness {
  const h = {
    row: { id: "w1", state: "IDLE", model: "opus", backend_kind: "claude", last_context_tokens: 140_000 },
    events: [], states: [], seeds: [], summarizeCalls: [], rearmed: [],
  } as unknown as Harness;
  const transcript: SessionTranscript | null = opts.transcript === undefined
    ? { entries: [{ kind: "user", text: "build the thing" }, { kind: "assistant", text: "built" }], path: "/tmp/s.jsonl" }
    : opts.transcript;
  const session = {
    capabilities: { contextCompaction: opts.capable ?? true },
    isAlive: () => true,
    readTranscript: async () => transcript,
    replaceContext: async (seed: string) => { h.seeds.push(seed); return { ok: true }; },
  } as unknown as AgentSession;
  const backend = { descriptor: { processModel: "in-process" }, attach: () => session } as unknown as AgentBackend;
  h.deps = {
    workers: {
      findById: () => h.row,
      updateState: (_id: string, s: string) => { h.row.state = s; h.states.push(s); },
      setTurnStartedAt: () => {},
      setContextTokens: (_id: string, t: number) => { h.row.last_context_tokens = t; },
    },
    events: { append: (_id: string, _ts: number, type: string, payload: Record<string, unknown>) => { h.events.push({ type, payload }); return h.events.length; } },
    bus: { publish: () => {} },
    clock: { now: () => 1_000 },
    backends: { has: () => true, get: () => backend, descriptors: () => [] },
    summarizer: {
      summarize: async (input: SummarizeInput) => {
        h.summarizeCalls.push(input);
        opts.onSummarize?.(h);
        return (opts.summary ?? (async () => "<analysis>x</analysis><summary>the summary</summary>"))();
      },
    },
    prompts: { render: (id: string, locals?: Record<string, unknown>) => `${id}|${JSON.stringify(locals ?? {})}` },
    contextWindowFor: () => 200_000,
    timeoutMs: () => 60_000,
    rearmContextMarks: (id: string) => { h.rearmed.push(id); },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as CompactContextDeps;
  return h;
}

const types = (h: Harness): string[] => h.events.filter((e) => e.type !== "state").map((e) => e.type);

describe("compactContext", () => {
  it("summarizes on the agent's model, seeds a fresh session, drops occupancy and records the boundary", async () => {
    const h = harness();
    const r = await compactContext(h.deps, { workerId: "w1", trigger: "manual", instructions: "  keep the API notes " });

    assert.equal(r.ok, true);
    assert.deepEqual(h.states, ["WORKING", "IDLE"], "held busy for the run, settled after");
    assert.deepEqual(types(h), ["compaction_started", "compaction_completed"]);
    assert.equal(h.summarizeCalls[0].model, "opus");
    assert.equal(h.summarizeCalls[0].timeoutMs, 60_000);
    assert.match(h.summarizeCalls[0].prompt, /^compaction\/summarize\|/);
    assert.match(h.summarizeCalls[0].prompt, /"INSTRUCTIONS":"keep the API notes"/);
    assert.match(h.summarizeCalls[0].prompt, /\[user\]\\nbuild the thing/);

    assert.equal(h.seeds.length, 1);
    assert.match(h.seeds[0], /^compaction\/continuation\|/);
    assert.match(h.seeds[0], /"SUMMARY":"the summary"/);
    assert.match(h.seeds[0], /"TRANSCRIPT_PATH":"\/tmp\/s.jsonl"/);

    const done = h.events.find((e) => e.type === "compaction_completed")!.payload;
    assert.equal(done.trigger, "manual");
    assert.equal(done.beforeTokens, 140_000);
    assert.equal(done.pct, 70);
    assert.equal(done.turns, 1);
    assert.equal(done.summary, "the summary");
    assert.equal(done.instructions, "keep the API notes");
    assert.ok(h.row.last_context_tokens < 140_000 && h.row.last_context_tokens === done.afterTokens);
    assert.deepEqual(h.rearmed, ["w1"]);
  });

  it("keeps the old session when the summarizer fails, and still settles to IDLE", async () => {
    const h = harness({ summary: async () => { throw new Error("summarizer timed out after 60s"); } });
    const r = await compactContext(h.deps, { workerId: "w1", trigger: "auto" });

    assert.deepEqual(r, { ok: false, error: "summarizer timed out after 60s" });
    assert.deepEqual(types(h), ["compaction_started", "compaction_failed"]);
    assert.deepEqual(h.seeds, [], "session never replaced");
    assert.equal(h.row.last_context_tokens, 140_000);
    assert.deepEqual(h.states, ["WORKING", "IDLE"]);
  });

  it("fails on an empty summary or an empty transcript", async () => {
    const empty = harness({ summary: async () => "<analysis>only thinking</analysis>" });
    assert.equal((await compactContext(empty.deps, { workerId: "w1", trigger: "auto" })).ok, false);
    assert.deepEqual(empty.seeds, []);

    const blank = harness({ transcript: null });
    const r = await compactContext(blank.deps, { workerId: "w1", trigger: "auto" });
    assert.deepEqual(r, { ok: false, error: "nothing to compact yet" });
    assert.equal(blank.summarizeCalls.length, 0);
  });

  it("does not revive an agent stopped while the summarizer ran", async () => {
    const h = harness({ onSummarize: (x) => { x.row.state = "ENDING"; } });
    const r = await compactContext(h.deps, { workerId: "w1", trigger: "auto" });

    assert.deepEqual(r, { ok: false, error: "agent stopped during compaction" });
    assert.deepEqual(h.seeds, []);
    assert.deepEqual(h.states, ["WORKING"], "no IDLE transition over the stop");
  });

  it("refuses an incapable session without touching state", async () => {
    const h = harness({ capable: false });
    const r = await compactContext(h.deps, { workerId: "w1", trigger: "manual" });
    assert.deepEqual(r, { ok: false, error: "this agent cannot be compacted" });
    assert.deepEqual(h.states, []);
    assert.deepEqual(h.events, []);
  });
});
