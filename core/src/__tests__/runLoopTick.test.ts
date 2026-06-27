import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runLoopTick, type RunLoopTickDeps } from "../use-cases/runLoopTick.ts";
import type { LoopRow, LoopAttempt } from "../ports/LoopStateRepo.ts";
import type { GoalContext } from "../ports/GoalCheckStrategy.ts";
import type { LoopProgressUpdate } from "../ports/LoopProgressSink.ts";
import type { GoalVerdict, GoalSpec } from "../../../contracts/src/loop.ts";

const GOAL: GoalSpec = { summary: "tests pass", criteria: [{ id: "c1", text: "npm test green", verify: "npm test" }] };

function loopRow(over: Partial<LoopRow> = {}): LoopRow {
  return {
    id: "l-1", workerId: "w-1", parentId: null, goal: GOAL, strategy: "command",
    status: "active", attempt: 0, maxAttempts: null, heldReport: null, heldOutput: null, lastReason: null,
    awaitingInput: false, progressRing: [], startedAt: 1000, updatedAt: 1000, ...over,
  };
}

function verdict(over: Partial<GoalVerdict> = {}): GoalVerdict {
  return { met: false, criteria: [{ id: "c1", met: false, evidence: "non-zero" }], unmet: ["c1"], confidence: 1, reason: "unmet: c1", ...over };
}

function buildDeps(loop: LoopRow | null, v: GoalVerdict, opts: { stateHash?: string; stopOnNoProgress?: boolean; noProgressWindow?: number; emitInStrategy?: (ctx: GoalContext) => void } = {}) {
  const statuses: Array<{ id: string; status: string }> = [];
  const attempts: Array<{ id: string; attempt: LoopAttempt }> = [];
  const dispatched: Array<{ workerId: string; text: string; origin: string }> = [];
  const renders: Array<{ id: string; vars: Record<string, unknown> }> = [];
  const held: Array<{ id: string; text: string | null }> = [];
  const released: Array<{ workerId: string; parentId: string; text: string }> = [];
  const ctxSeen: GoalContext[] = [];
  const progress: LoopProgressUpdate[] = [];
  const deps = {
    loops: {
      findActiveByWorker: () => loop,
      setStatus: (id: string, status: string) => { statuses.push({ id, status }); },
      recordAttempt: (id: string, attempt: LoopAttempt) => { attempts.push({ id, attempt }); },
      setHeldReport: (id: string, text: string | null) => { held.push({ id, text }); },
    },
    strategyFor: () => ({ evaluate: async (_goal: GoalSpec, ctx: GoalContext) => { ctxSeen.push(ctx); opts.emitInStrategy?.(ctx); return v; } }),
    dispatch: async (input: { workerId: string; text: string; origin: string }) => { dispatched.push(input); return {}; },
    releaseReport: async (input: { workerId: string; parentId: string; text: string }) => { released.push(input); return {}; },
    stateHash: async () => opts.stateHash ?? "state-fresh",
    noProgressWindow: opts.noProgressWindow ?? 3,
    stopOnNoProgress: opts.stopOnNoProgress ?? true,
    renderer: { render: (id: string, vars: Record<string, unknown>) => { renders.push({ id, vars }); return `RENDERED:${id}:attempt=${vars?.ATTEMPT}`; } },
    progress: (u: LoopProgressUpdate) => { progress.push(u); },
    clock: { now: () => 1234 },
    log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
  } as unknown as RunLoopTickDeps;
  return { deps, statuses, attempts, dispatched, renders, held, released, ctxSeen, progress };
}

// A frozen ring: window-1 prior attempts, all the same stateHash + unmet count.
function frozenRing(stateHash: string, unmetCount: number, n: number): LoopAttempt[] {
  return Array.from({ length: n }, () => ({ stateHash, outcomeHash: "c1", unmetCount, reason: "r" }));
}

describe("runLoopTick", () => {
  it("no active loop → noop", async () => {
    const { deps, dispatched } = buildDeps(null, verdict());
    assert.equal(await runLoopTick(deps, { workerId: "w-1" }), "noop");
    assert.equal(dispatched.length, 0);
  });

  it("awaiting input → noop: no goal-check, no dispatch, no attempt burned", async () => {
    const { deps, dispatched, attempts, statuses } = buildDeps(loopRow({ awaitingInput: true, maxAttempts: 3 }), verdict());
    assert.equal(await runLoopTick(deps, { workerId: "w-1" }), "noop");
    assert.equal(dispatched.length, 0);
    assert.equal(attempts.length, 0);
    assert.equal(statuses.length, 0);
  });

  it("goal met → released + status passed, no dispatch", async () => {
    const { deps, statuses, dispatched } = buildDeps(loopRow(), verdict({ met: true, unmet: [], reason: "all passed" }));
    assert.equal(await runLoopTick(deps, { workerId: "w-1" }), "released");
    assert.deepEqual(statuses, [{ id: "l-1", status: "passed" }]);
    assert.equal(dispatched.length, 0);
  });

  it("goal unmet with budget left → continued + recordAttempt + renders continuation template + one dispatch (origin loop)", async () => {
    const { deps, attempts, dispatched, renders } = buildDeps(loopRow({ attempt: 0, maxAttempts: 3 }), verdict());
    assert.equal(await runLoopTick(deps, { workerId: "w-1" }), "continued");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].attempt.reason, "unmet: c1");
    // Prose comes from the central template — runLoopTick only shapes vars + renders.
    assert.equal(renders.length, 1);
    assert.equal(renders[0].id, "loop/continuation");
    assert.equal(renders[0].vars.ATTEMPT, "1");
    assert.match(String(renders[0].vars.UNMET), /npm test green/);
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].origin, "loop");
    assert.equal(dispatched[0].text, "RENDERED:loop/continuation:attempt=1");
  });

  it("goal unmet at the attempt limit → exhausted, no dispatch", async () => {
    // maxAttempts=2, attempt already 2 → nextAttempt 3 > 2.
    const { deps, statuses, dispatched } = buildDeps(loopRow({ attempt: 2, maxAttempts: 2 }), verdict());
    assert.equal(await runLoopTick(deps, { workerId: "w-1" }), "exhausted");
    assert.deepEqual(statuses, [{ id: "l-1", status: "exhausted" }]);
    assert.equal(dispatched.length, 0);
  });

  it("unbounded loop (maxAttempts null) never exhausts", async () => {
    const { deps, dispatched } = buildDeps(loopRow({ attempt: 999, maxAttempts: null }), verdict());
    assert.equal(await runLoopTick(deps, { workerId: "w-1" }), "continued");
    assert.equal(dispatched.length, 1);
  });

  it("MET with a held report → releases it to the parent and clears it", async () => {
    const { deps, statuses, held, released } = buildDeps(
      loopRow({ parentId: "o-1", heldReport: "result: done" }),
      verdict({ met: true, unmet: [], reason: "all passed" }),
    );
    assert.equal(await runLoopTick(deps, { workerId: "w-1" }), "released");
    assert.deepEqual(released, [{ workerId: "w-1", parentId: "o-1", text: "result: done" }]);
    assert.deepEqual(held, [{ id: "l-1", text: null }]);   // held report cleared
    assert.deepEqual(statuses, [{ id: "l-1", status: "passed" }]);
  });

  it("MET on a self-loop (no parent) → passes, nothing released", async () => {
    const { deps, released, held } = buildDeps(loopRow(), verdict({ met: true, unmet: [], reason: "ok" }));
    assert.equal(await runLoopTick(deps, { workerId: "w-1" }), "released");
    assert.equal(released.length, 0);   // no parent to report to
    assert.equal(held.length, 0);
  });

  it("MET with NO held report but a parent → SYNTHESIZES a completion and dispatches exactly one terminal message", async () => {
    const { deps, released, renders, statuses } = buildDeps(
      loopRow({ parentId: "o-1", heldReport: null, attempt: 3, maxAttempts: null }),
      verdict({ met: true, unmet: [], reason: "ok" }),
    );
    assert.equal(await runLoopTick(deps, { workerId: "w-1" }), "released");
    const complete = renders.find((r) => r.id === "loop/loop-complete");
    assert.ok(complete, "renders the synthesized loop-complete template");
    assert.equal(complete.vars.ATTEMPTS, "4");          // attempt 3 + the initial pass
    assert.equal(released.length, 1);                    // exactly one terminal message
    assert.match(released[0].text, /loop-complete/);
    assert.deepEqual(statuses, [{ id: "l-1", status: "passed" }]);
  });

  it("EXHAUSTED with a held report → releases an ANNOTATED report (exhausted-release template) and clears it", async () => {
    const { deps, statuses, held, released, renders } = buildDeps(
      loopRow({ parentId: "o-1", heldReport: "result: claimed done", attempt: 2, maxAttempts: 2 }),
      verdict(),
    );
    assert.equal(await runLoopTick(deps, { workerId: "w-1" }), "exhausted");
    const exh = renders.find((r) => r.id === "loop/exhausted-release");
    assert.ok(exh, "renders the exhausted-release template");
    assert.equal(exh.vars.REPORT, "result: claimed done");   // the held report is annotated
    assert.equal(released.length, 1);
    assert.equal(released[0].parentId, "o-1");
    assert.match(released[0].text, /exhausted-release/);      // the rendered annotation, not the raw report
    assert.deepEqual(held, [{ id: "l-1", text: null }]);
    assert.deepEqual(statuses, [{ id: "l-1", status: "exhausted" }]);
  });

  it("EXHAUSTED with NO held report but a parent → SYNTHESIZES an exhausted message (exactly one terminal message)", async () => {
    const { deps, released, renders, statuses } = buildDeps(
      loopRow({ parentId: "o-1", heldReport: null, attempt: 2, maxAttempts: 2 }),
      verdict(),
    );
    assert.equal(await runLoopTick(deps, { workerId: "w-1" }), "exhausted");
    const synth = renders.find((r) => r.id === "loop/loop-exhausted");
    assert.ok(synth, "renders the synthesized loop-exhausted template");
    assert.match(String(synth.vars.REASON), /attempt limit/);
    assert.equal(released.length, 1);
    assert.match(released[0].text, /loop-exhausted/);
    assert.deepEqual(statuses, [{ id: "l-1", status: "exhausted" }]);
  });

  it("CONTINUE (unmet, budget left) with a held report → discards it (never released), re-triggers", async () => {
    const { deps, held, released, dispatched } = buildDeps(
      loopRow({ parentId: "o-1", heldReport: "result: premature", attempt: 0, maxAttempts: 3 }),
      verdict(),
    );
    assert.equal(await runLoopTick(deps, { workerId: "w-1" }), "continued");
    assert.deepEqual(held, [{ id: "l-1", text: null }]);   // discarded
    assert.equal(released.length, 0);                      // NOT forwarded
    assert.equal(dispatched.length, 1);                    // re-triggered
  });
});

describe("runLoopTick — no-progress guardrail", () => {
  it("frozen change-set across the window + non-shrinking unmet → exhausted + annotated release", async () => {
    const { deps, statuses, dispatched, renders, released } = buildDeps(
      loopRow({ parentId: "o-1", heldReport: "result: stuck", maxAttempts: null, attempt: 2, progressRing: frozenRing("h", 1, 2) }),
      verdict(),                       // unmet ["c1"], count 1 → not shrinking vs ring's 1
      { stateHash: "h" },
    );
    assert.equal(await runLoopTick(deps, { workerId: "w-1" }), "exhausted");
    assert.deepEqual(statuses, [{ id: "l-1", status: "exhausted" }]);
    assert.equal(dispatched.length, 0);                    // NOT re-triggered
    const exh = renders.find((r) => r.id === "loop/exhausted-release");
    assert.match(String(exh?.vars.REASON), /no progress/);
    assert.equal(released.length, 1);
  });

  it("stopOnNoProgress=false → never stops on no-progress, runs on (continues)", async () => {
    const { deps, dispatched, statuses } = buildDeps(
      loopRow({ maxAttempts: null, attempt: 2, progressRing: frozenRing("h", 1, 2) }),
      verdict(),
      { stateHash: "h", stopOnNoProgress: false },
    );
    assert.equal(await runLoopTick(deps, { workerId: "w-1" }), "continued");
    assert.equal(dispatched.length, 1);
    assert.equal(statuses.length, 0);
  });

  it("shrinking unmet across the window → continues (real convergence is not flagged)", async () => {
    const ring = [
      { stateHash: "h", outcomeHash: "x", unmetCount: 2, reason: "r" },
      { stateHash: "h", outcomeHash: "x", unmetCount: 2, reason: "r" },
    ];
    const { deps, dispatched } = buildDeps(
      loopRow({ maxAttempts: null, attempt: 2, progressRing: ring }),
      verdict(),                       // current unmet count 1 < ring's 2 → improved
      { stateHash: "h" },
    );
    assert.equal(await runLoopTick(deps, { workerId: "w-1" }), "continued");
    assert.equal(dispatched.length, 1);
  });

  it("a fresh change-set each attempt (distinct states) → continues", async () => {
    const ring = [
      { stateHash: "h1", outcomeHash: "x", unmetCount: 1, reason: "r" },
      { stateHash: "h2", outcomeHash: "x", unmetCount: 1, reason: "r" },
    ];
    const { deps, dispatched } = buildDeps(
      loopRow({ maxAttempts: null, attempt: 2, progressRing: ring }),
      verdict(),
      { stateHash: "h3" },             // distinct from the ring → 3 distinct → not flagged
    );
    assert.equal(await runLoopTick(deps, { workerId: "w-1" }), "continued");
    assert.equal(dispatched.length, 1);
  });
});

describe("runLoopTick — precedence (goal-met → attemptLimit → no-progress)", () => {
  it("goal-met WINS over the attempt limit (a goal met on the final attempt is a success, not an exhaustion)", async () => {
    const { deps, statuses } = buildDeps(
      loopRow({ attempt: 5, maxAttempts: 5 }),     // already at the limit
      verdict({ met: true, unmet: [], reason: "ok" }),
    );
    assert.equal(await runLoopTick(deps, { workerId: "w-1" }), "released");
    assert.deepEqual(statuses, [{ id: "l-1", status: "passed" }]);
  });

  it("for an UNMET goal, attemptLimit wins over no-progress (reason names the attempt limit)", async () => {
    const { deps, renders } = buildDeps(
      loopRow({ parentId: "o-1", heldReport: "r", attempt: 2, maxAttempts: 2, progressRing: frozenRing("h", 1, 2) }),
      verdict(),                       // unmet — a frozen ring is present, but the attempt limit fires first
      { stateHash: "h" },
    );
    assert.equal(await runLoopTick(deps, { workerId: "w-1" }), "exhausted");
    const exh = renders.find((r) => r.id === "loop/exhausted-release");
    assert.match(String(exh?.vars.REASON), /attempt limit/);
  });
});

describe("runLoopTick — progress sink", () => {
  it("emits started → (strategy phase) → verdict, enriched with attempt/strategy", async () => {
    const { deps, progress } = buildDeps(
      loopRow({ attempt: 1, maxAttempts: 5, strategy: "command" }),
      verdict(),
      { emitInStrategy: (ctx) => ctx.progress?.({ phase: "verifying", criterionId: "c1" }) },
    );
    assert.equal(await runLoopTick(deps, { workerId: "w-1" }), "continued");
    assert.deepEqual(progress.map((p) => p.phase), ["started", "verifying", "verdict"]);
    // attempt/strategy are stamped on every update; the worker pass being checked
    // is attempt+1 (the human-facing count the loop card shows).
    assert.ok(progress.every((p) => p.attempt === 2 && p.maxAttempts === 5 && p.strategy === "command"));
    assert.equal(progress[1].criterionId, "c1");
    const last = progress[progress.length - 1];
    assert.deepEqual({ met: last.met, outcome: last.outcome }, { met: false, outcome: "continued" });
    assert.equal(last.reason, "unmet: c1");
  });

  it("verdict carries outcome:released when the goal is met", async () => {
    const { deps, progress } = buildDeps(loopRow(), verdict({ met: true, unmet: [], reason: "all passed" }));
    assert.equal(await runLoopTick(deps, { workerId: "w-1" }), "released");
    const last = progress[progress.length - 1];
    assert.deepEqual({ phase: last.phase, met: last.met, outcome: last.outcome }, { phase: "verdict", met: true, outcome: "released" });
  });

  it("verdict carries outcome:exhausted at the attempt limit", async () => {
    const { deps, progress } = buildDeps(loopRow({ attempt: 2, maxAttempts: 2 }), verdict());
    assert.equal(await runLoopTick(deps, { workerId: "w-1" }), "exhausted");
    const last = progress[progress.length - 1];
    assert.equal(last.outcome, "exhausted");
    assert.match(String(last.reason), /attempt limit/);
  });

  it("a no-op tick (no active loop) emits nothing", async () => {
    const { deps, progress } = buildDeps(null, verdict());
    await runLoopTick(deps, { workerId: "w-1" });
    assert.equal(progress.length, 0);
  });
});

describe("runLoopTick — judge context", () => {
  it("passes the held report to the strategy as the claim to demote (lastReportText)", async () => {
    const { deps, ctxSeen } = buildDeps(
      loopRow({ parentId: "o-1", heldReport: "result: I claim it's done", maxAttempts: null }),
      verdict(),
    );
    await runLoopTick(deps, { workerId: "w-1" });
    assert.equal(ctxSeen[0]?.lastReportText, "result: I claim it's done");
  });

  it("falls back to the caller-supplied lastReportText when no report is held", async () => {
    const { deps, ctxSeen } = buildDeps(loopRow({ heldReport: null, maxAttempts: null }), verdict());
    await runLoopTick(deps, { workerId: "w-1", lastReportText: "from-input" });
    assert.equal(ctxSeen[0]?.lastReportText, "from-input");
  });
});
