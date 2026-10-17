import { describe, it, expect } from "vitest";
import { agentActivity, metaPhasesOf, runStatusOf, workflowDescriptionOf, workflowNameOf, workflowRunModel } from "./workflowRuns.js";

const SCRIPT = `export const meta = {
  name: 'review-changes',
  description: 'Review changed files, verify each finding',
  phases: [
    { title: 'Scope', detail: 'collect changed files' },
    { title: 'Review', detail: "one reviewer per dimension, it's quick" },
    { title: 'Verify' },
  ],
}

const x = await agent('do things', { label: 'scope:diff', phase: 'Scope' })
`;

const tool = { id: "wf1", name: "Workflow", input: { script: SCRIPT }, ts: 1_000 };
const NOW = 61_000;

const agent = (o) => ({ index: 1, label: "a", state: "running", ...o });
const snap = (agents, extra = {}) => ({ phases: [{ index: 1, title: "Scope" }, { index: 2, title: "Review" }], agents, logs: [], ...extra });

describe("reading the call", () => {
  it("names the run from meta, a named workflow, or its script file", () => {
    expect(workflowNameOf(tool.input)).toBe("review-changes");
    expect(workflowNameOf({ name: "spec" })).toBe("spec");
    expect(workflowNameOf({ scriptPath: "/x/workflows/scripts/genui-build-wf_5dc20956-fb7.js" })).toBe("genui-build");
    expect(workflowNameOf({})).toBe("workflow");
    expect(workflowDescriptionOf(tool.input)).toBe("Review changed files, verify each finding");
  });

  it("reads the planned phases, escaped quotes included, without running anything", () => {
    expect(metaPhasesOf(tool.input)).toEqual([
      { index: 1, title: "Scope", detail: "collect changed files" },
      { index: 2, title: "Review", detail: "one reviewer per dimension, it's quick" },
      { index: 3, title: "Verify" },
    ]);
    expect(metaPhasesOf({ scriptPath: "/x.js" })).toEqual([]);
  });
});

describe("agentActivity", () => {
  it("says what an agent does now, or what it came to", () => {
    expect(agentActivity(agent({ lastToolName: "Read", lastToolSummary: "src/a.ts" }))).toBe("Reading src/a.ts");
    expect(agentActivity(agent({ lastToolName: "mcp__x__y" }))).toBe("mcp__x__y");
    expect(agentActivity(agent({}))).toBe("Thinking…");
    expect(agentActivity(agent({ state: "queued" }))).toBe("Waiting to start");
    expect(agentActivity(agent({ state: "done", resultPreview: "\n3 findings\nmore" }))).toBe("3 findings");
    expect(agentActivity(agent({ state: "done" }))).toBe("Done");
    expect(agentActivity(agent({ state: "error", error: "blocked: rm -rf" }))).toBe("blocked: rm -rf");
  });
});

describe("runStatusOf", () => {
  const block = { tool, started: { taskId: "t1", ts: 1_500 }, completed: null };
  it("the recorded end wins, then a live end, then the daemon's word", () => {
    expect(runStatusOf({ ...block, completed: { status: "failed" } }, { live: { status: "running" } })).toBe("failed");
    expect(runStatusOf(block, { live: { status: "stopped" } })).toBe("stopped");
    expect(runStatusOf(block, { detail: { status: "stopped" } })).toBe("stopped");
    expect(runStatusOf(block, null)).toBe("running");
    expect(runStatusOf({ tool, started: null, completed: null }, null)).toBe("starting");
  });
});

describe("workflowRunModel", () => {
  const block = { tool, started: { taskId: "t1", name: "review-changes", ts: 1_000 }, completed: null };

  it("a running run: planned phases, live agents, the phase it is in", () => {
    const live = {
      status: "running",
      snapshot: snap([
        agent({ index: 1, label: "scope:diff", phaseIndex: 1, agentId: "aaaaaa1", state: "done", durationMs: 38_000, tokens: 22_000, toolCalls: 9, resultPreview: "14 files" }),
        agent({ index: 2, label: "review:bugs", phaseIndex: 2, agentId: "aaaaaa2", startedAt: 40_000, lastToolName: "Grep", lastToolSummary: "replaces", tokens: 10_000 }),
        agent({ index: 3, label: "review:perf", phaseIndex: 2, state: "queued" }),
      ]),
      usage: { totalTokens: 50_000, toolUses: 30 },
    };
    const m = workflowRunModel(block, { live, detail: { status: "running", canStop: true, snapshot: snap([]) } }, NOW);
    expect(m.status).toBe("running");
    expect(m.name).toBe("review-changes");
    expect(m.elapsedMs).toBe(60_000);
    expect(m.canStop).toBe(true);
    expect(m.phases.map((p) => [p.title, p.state, p.detail ?? null])).toEqual([
      ["Scope", "done", "collect changed files"],
      ["Review", "running", "one reviewer per dimension, it's quick"],
      ["Verify", "pending", null],
    ]);
    expect(m.currentPhase.title).toBe("Review");
    const review = m.phases[1];
    expect(review.counts).toMatchObject({ total: 2, running: 1, queued: 1, done: 0 });
    expect(review.agents[0]).toMatchObject({ activity: "Searching replaces", elapsedMs: 21_000, glyphStatus: "running" });
    expect(review.agents[0].identity).toHaveProperty("glyph");
    expect(m.totals).toMatchObject({ agents: 3, running: 1, queued: 1, done: 1, tokens: 50_000, toolUses: 30 });
  });

  it("a finished run reads its record: details and the script's log", () => {
    const finished = { ...block, completed: { status: "completed", ts: 9_000, usage: { durationMs: 8_000 }, snapshot: snap([agent({ phaseIndex: 1, state: "done" })]) } };
    const detail = { status: "completed", canStop: false, snapshot: snap([agent({ phaseIndex: 1, state: "done", resultPreview: "ok" })], { logs: ["Scope: done — 14 files"] }) };
    const m = workflowRunModel(finished, { detail }, NOW);
    expect(m.status).toBe("completed");
    expect(m.active).toBe(false);
    expect(m.elapsedMs).toBe(8_000);
    expect(m.logs).toEqual(["Scope: done — 14 files"]);
    expect(m.agents[0].activity).toBe("ok");
    expect(m.canStop).toBe(false);
  });

  it("a stopped run shows no live agents: what was in flight reads as stopped", () => {
    const stale = snap([
      agent({ index: 1, label: "scope:diff", phaseIndex: 1, state: "done" }),
      agent({ index: 2, label: "review:bugs", phaseIndex: 2, startedAt: 40_000, lastProgressAt: 48_000 }),
      agent({ index: 3, label: "review:perf", phaseIndex: 2, state: "queued" }),
    ]);
    const m = workflowRunModel({ ...block, completed: { status: "stopped", ts: 50_000, snapshot: stale } }, null, NOW);
    expect(m.status).toBe("stopped");
    expect(m.totals).toMatchObject({ running: 0, queued: 0, stopped: 2, failed: 0 });
    const review = m.phases[1];
    expect(review.state).toBe("stopped");
    expect(review.counts.stopped).toBe(2);
    expect(review.agents.map((a) => a.activity)).toEqual(["Stopped", "Stopped"]);
    expect(review.agents[0].glyphStatus).toBe("stopped");
    expect(m.currentPhase).toBe(null);
  });

  it("agents outside any phase() share one group up front", () => {
    const live = { status: "running", snapshot: { phases: [], agents: [agent({ label: "solo" })], logs: [] } };
    const m = workflowRunModel({ tool: { id: "wf2", input: {} }, started: null, completed: null }, { live }, NOW);
    expect(m.phases.map((p) => [p.index, p.title])).toEqual([[0, "Agents"]]);
    expect(m.phases[0].agents[0].label).toBe("solo");
  });
});
