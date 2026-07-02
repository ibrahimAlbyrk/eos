import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeAutoNameTask, isNameable, interpretModelOutput, NO_TITLE_SENTINEL, type AutoNameDeps } from "../micro-tasks/autoName.ts";
import { buildMicroTasks } from "../micro-tasks/registry.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { WorkerEventRow } from "../../../contracts/src/events.ts";

type RowState = { is_orchestrator?: number; name_source?: string | null; name?: string | null };

function ev(id: number, type: string, payload: unknown): WorkerEventRow {
  return { id, worker_id: "w1", ts: id, type, payload: payload == null ? null : JSON.stringify(payload) };
}

const ctx = { entityId: "w1", now: 0 };

function setup(opts: { row?: RowState | null; events?: WorkerEventRow[]; charLimit?: number } = {}) {
  const row = opts.row === undefined ? { is_orchestrator: 1, name_source: "default", name: "rnd" } : opts.row;
  const store: Record<string, RowState> = row ? { w1: row } : {};
  const published: Array<{ workerId: string }> = [];
  const deps: AutoNameDeps = {
    workers: {
      findById: (id: string) => (store[id] ?? null) as unknown as WorkerRow | null,
      updateNameIfSource: (id, name, expected, next) => {
        const r = store[id];
        if (!r || r.name_source !== expected) return false;
        r.name = name; r.name_source = next; return true;
      },
    },
    events: { list: () => opts.events ?? [] },
    bus: { publish: (_t, p) => { published.push(p as { workerId: string }); } },
    cfg: () => ({ charLimit: opts.charLimit ?? 280 }),
  };
  return { task: makeAutoNameTask(deps), store, published };
}

describe("auto-name trigger.match", () => {
  it("topic is worker:change", () => {
    assert.equal(setup().task.trigger.topic, "worker:change");
  });

  it("matches only the entry INTO WORKING from SPAWNING/IDLE", () => {
    const m = setup().task.trigger;
    assert.equal(m.match({ workerId: "w1", state: "WORKING", from: "SPAWNING" }), "w1");
    assert.equal(m.match({ workerId: "w1", state: "WORKING", from: "IDLE" }), "w1");
    assert.equal(m.match({ workerId: "w1", state: "IDLE", from: "WORKING" }), null);
    assert.equal(m.match({ workerId: "w1", state: "WORKING", from: "ENDING" }), null);
    assert.equal(m.match({ workerId: "w1", rowId: 5 }), null);     // plain worker:change (no state)
    assert.equal(m.match({ state: "WORKING", from: "IDLE" }), null); // no workerId
  });
});

describe("auto-name gate", () => {
  it("true for an orchestrator whose name_source is 'default'", async () => {
    assert.equal(await setup({ row: { is_orchestrator: 1, name_source: "default" } }).task.gate(ctx), true);
  });

  it("false for a non-orchestrator", async () => {
    assert.equal(await setup({ row: { is_orchestrator: 0, name_source: "default" } }).task.gate(ctx), false);
  });

  it("false for name_source 'user' | 'auto' | NULL", async () => {
    for (const src of ["user", "auto", null] as const) {
      assert.equal(await setup({ row: { is_orchestrator: 1, name_source: src } }).task.gate(ctx), false, `src=${src}`);
    }
  });

  it("false when the row is gone", async () => {
    assert.equal(await setup({ row: null }).task.gate(ctx), false);
  });
});

describe("auto-name isNameable", () => {
  it("rejects greetings / too-short / single-word / symbol-only", () => {
    assert.equal(isNameable("hi"), false);            // < 6 chars
    assert.equal(isNameable("asdf"), false);          // one word
    assert.equal(isNameable("??"), false);            // no letters, too short
    assert.equal(isNameable("Kafka"), false);         // one word
  });

  it("accepts a real multi-word request, incl. non-ASCII letters", () => {
    assert.equal(isNameable("fix the login bug"), true);
    assert.equal(isNameable("iOS relay bağlantısını düzelt"), true); // \p{L} counts Turkish
  });
});

describe("auto-name extract", () => {
  it("returns only USER_INPUT, truncated to charLimit", async () => {
    const { task } = setup({ charLimit: 10, events: [ev(1, "user_message", { text: "fix the login bug" })] });
    const vars = await task.extract(ctx);
    assert.equal(vars?.USER_INPUT, "fix the lo"); // truncated to 10
    assert.equal("FIRST_OUTPUT" in (vars ?? {}), false); // FIRST_OUTPUT fully removed
  });

  it("returns null (LLM skipped) for an unnameable request", async () => {
    for (const bad of ["hi", "??", "Kafka"]) {
      const { task } = setup({ events: [ev(1, "user_message", { text: bad })] });
      assert.equal(await task.extract(ctx), null, `bad=${bad}`);
    }
  });

  it("returns null when there is no user message", async () => {
    const { task } = setup({ events: [ev(1, "agent_event", { type: "message", role: "assistant", blocks: [{ type: "text", text: "hi" }] })] });
    assert.equal(await task.extract(ctx), null);
  });
});

describe("auto-name interpretModelOutput", () => {
  it("the NO_TITLE sentinel → null", () => {
    assert.equal(interpretModelOutput(NO_TITLE_SENTINEL, ""), null);
    assert.equal(interpretModelOutput("NO_TITLE", "fix the login bug"), null);
  });

  it("a refusal / preamble opener → null", () => {
    assert.equal(interpretModelOutput("I'm sorry, I can't do that", ""), null);
  });

  it("a near-verbatim echo of the request → null", () => {
    assert.equal(interpretModelOutput("Refactor the payment", "Refactor the payment module"), null);
  });

  it("an answer-shaped line (> MAX_TOPIC_WORDS) → null", () => {
    assert.equal(interpretModelOutput("This line has far too many words to be a topic", ""), null);
  });

  it("a real topic → '<Topic> Orchestrator' (appears verbatim in request, not echo)", () => {
    assert.equal(interpretModelOutput("Kafka Consumer", "rewrite the Kafka consumer"), "Kafka Consumer Orchestrator");
  });
});

describe("auto-name apply", () => {
  it("'game fix' → 'Game Fix Orchestrator', CAS-written + publishes", async () => {
    const s = setup({ row: { is_orchestrator: 1, name_source: "default", name: "rnd" } });
    await s.task.apply(ctx, "game fix");
    assert.equal(s.store.w1.name, "Game Fix Orchestrator");
    assert.equal(s.store.w1.name_source, "auto");
    assert.deepEqual(s.published, [{ workerId: "w1" }]);
  });

  it("does NOT double the suffix when the model already ended in Orchestrator", async () => {
    const s1 = setup({ row: { is_orchestrator: 1, name_source: "default" } });
    await s1.task.apply(ctx, "Auth Refactor Orchestrator");
    assert.equal(s1.store.w1.name, "Auth Refactor Orchestrator");

    const s2 = setup({ row: { is_orchestrator: 1, name_source: "default" } });
    await s2.task.apply(ctx, "game fix orchestrator"); // lowercase suffix normalized
    assert.equal(s2.store.w1.name, "Game Fix Orchestrator");
  });

  it("strips wrapping quotes/markdown and trailing punctuation", async () => {
    const s = setup({ row: { is_orchestrator: 1, name_source: "default" } });
    await s.task.apply(ctx, "**\"game fix.\"**");
    assert.equal(s.store.w1.name, "Game Fix Orchestrator");
  });

  it("empty / whitespace / punctuation-only / bare-suffix output aborts (no write)", async () => {
    for (const bad of ["", "   ", "...", "!!!", '""', "``", "Orchestrator"]) {
      const s = setup({ row: { is_orchestrator: 1, name_source: "default", name: "kept" } });
      await s.task.apply(ctx, bad);
      assert.equal(s.store.w1.name, "kept", `bad=${JSON.stringify(bad)}`);
      assert.equal(s.store.w1.name_source, "default");
      assert.equal(s.published.length, 0);
    }
  });

  it("I1 — never clobbers a 'user' row: CAS no-op, no publish", async () => {
    const s = setup({ row: { is_orchestrator: 1, name_source: "user", name: "My Name" } });
    await s.task.apply(ctx, "game fix");
    assert.equal(s.store.w1.name, "My Name");
    assert.equal(s.store.w1.name_source, "user");
    assert.equal(s.published.length, 0);
  });
});

describe("auto-name end-to-end", () => {
  it("a 'default' orchestrator becomes '<Topic> Orchestrator'; a 'user' one is never touched", async () => {
    const d = setup({ row: { is_orchestrator: 1, name_source: "default", name: "rnd" } });
    assert.equal(await d.task.gate(ctx), true);
    await d.task.apply(ctx, "game fix");
    assert.equal(d.store.w1.name, "Game Fix Orchestrator");
    assert.equal(d.store.w1.name_source, "auto");

    const u = setup({ row: { is_orchestrator: 1, name_source: "user", name: "Mine" } });
    assert.equal(await u.task.gate(ctx), false);
    await u.task.apply(ctx, "game fix");
    assert.equal(u.store.w1.name, "Mine");
    assert.equal(u.store.w1.name_source, "user");
  });
});

describe("micro-task registry", () => {
  it("buildMicroTasks wires the auto-name task", () => {
    const tasks = buildMicroTasks({
      workers: { findById: () => null, updateNameIfSource: () => false },
      events: { list: () => [] },
      bus: { publish: () => {} },
      cfg: () => ({ charLimit: 280 }),
    });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, "auto-name");
    assert.equal(tasks[0].promptId, "micro-tasks/auto-name");
  });
});
