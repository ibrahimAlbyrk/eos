import { describe, it, expect } from "vitest";
import {
  collectSubagents, groupSubagentRuns, splitByStatus, nameSeparator, launchVerb,
  subagentElapsedMs, subagentStatusPhrase, cleanSubagentResult, subagentMeta, batchSummary,
} from "./subagentRuns.js";

const run = (toolUseId, ts, extra = {}) => ({ kind: "agentRun", toolUseId, ts, status: "completed", tools: [], endTs: null, usage: null, ...extra });

describe("collectSubagents", () => {
  it("lists agentRuns in spawn order, each with an identity", () => {
    const out = collectSubagents([run("b", 20), { kind: "assistant", ts: 5 }, run("a", 10)]);
    expect(out.map((r) => r.toolUseId)).toEqual(["a", "b"]);
    expect(out.every((r) => r.identity?.hex && r.identity.glyph)).toBe(true);
    expect(out[0].identity).not.toEqual(out[1].identity);
  });
});

describe("groupSubagentRuns", () => {
  it("folds consecutive agentRuns into one launch line and keeps other blocks", () => {
    const blocks = [{ kind: "assistant", ts: 1 }, run("a", 2), run("b", 3), { kind: "thinking", ts: 4 }, run("c", 5)];
    const out = groupSubagentRuns(blocks, collectSubagents(blocks));
    expect(out.map((b) => b.kind)).toEqual(["assistant", "subagents", "thinking", "subagents"]);
    expect(out[1].runs.map((r) => r.toolUseId)).toEqual(["a", "b"]);
    expect(out[1].ts).toBe(2);
    expect(out[1].runs[0].identity).toBeDefined();
  });
});

describe("splitByStatus", () => {
  it("keeps active in launch order and puts the latest finisher first", () => {
    const { active, done } = splitByStatus([
      run("a", 1, { endTs: 10 }), run("b", 2, { status: "running" }), run("c", 3, { endTs: 30 }), run("d", 4, { status: "running" }),
    ]);
    expect(active.map((r) => r.toolUseId)).toEqual(["b", "d"]);
    expect(done.map((r) => r.toolUseId)).toEqual(["c", "a"]);
  });
});

describe("launch line text", () => {
  it("joins names as 'A, B and C'", () => {
    const names = ["A", "B", "C"];
    expect(names.map((n, i) => n + nameSeparator(i, names.length)).join("")).toBe("A, B and C ");
    expect("A" + nameSeparator(0, 1)).toBe("A ");
  });

  it("says 'started working' until every subagent is done", () => {
    expect(launchVerb([run("a", 1), run("b", 2, { status: "running" })])).toBe("started working");
    expect(launchVerb([run("a", 1), run("b", 2, { status: "failed" })])).toBe("finished");
  });
});

describe("subagent timing", () => {
  it("counts live time while running", () => {
    expect(subagentElapsedMs(run("a", 1000, { status: "running" }), 13_000)).toBe(12_000);
  });

  it("prefers the lane's own duration, then start → end, then start → last tool", () => {
    expect(subagentElapsedMs(run("a", 0, { usage: { durationMs: 5000 }, endTs: 9000 }), 0)).toBe(5000);
    expect(subagentElapsedMs(run("a", 1000, { endTs: 35_000 }), 0)).toBe(34_000);
    expect(subagentElapsedMs(run("a", 1000, { tools: [{ ts: 4000 }] }), 0)).toBe(3000);
    expect(subagentElapsedMs(run("a", 1000), 0)).toBe(null);
  });

  it("phrases the status with its time", () => {
    expect(subagentStatusPhrase(run("a", 0, { endTs: 34_000 }), 0)).toBe("Worked for 34s");
    expect(subagentStatusPhrase(run("a", 0, { status: "running" }), 12_000)).toBe("Working for 12s");
    expect(subagentStatusPhrase(run("a", 0, { status: "failed", endTs: 3000 }), 0)).toBe("Failed after 3s");
    expect(subagentStatusPhrase(run("a", 0), 0)).toBe("Finished");
  });
});

describe("subagentMeta", () => {
  it("shows live time, when it finished, or what went wrong", () => {
    expect(subagentMeta(run("a", 1000, { status: "running" }), 42_000)).toEqual({ text: "41s", tone: "time" });
    expect(subagentMeta(run("a", 0, { endTs: 1000 }), 5 * 60_000)).toEqual({ text: "4m ago", tone: "ago" });
    expect(subagentMeta(run("a", 0, { status: "stopped" }), 0)).toEqual({ text: "stopped", tone: "failed" });
  });
});

describe("batchSummary", () => {
  it("tallies a batch at work", () => {
    const runs = [run("a", 0, { status: "running" }), run("b", 0, { status: "running" }), run("c", 0, { endTs: 5000 }), run("d", 0, { status: "failed" })];
    expect(batchSummary(runs, 10_000)).toBe("2 running · 1 done · 1 failed");
  });

  it("tells how long a finished batch took, first start to last end", () => {
    const runs = [run("a", 1000, { endTs: 40_000 }), run("b", 2000, { endTs: 131_000 }), run("c", 1500, { status: "stopped", endTs: 9000 })];
    expect(batchSummary(runs, 0)).toBe("1 stopped · 2m 10s");
  });
});

describe("cleanSubagentResult", () => {
  it("drops the <usage> footer", () => {
    expect(cleanSubagentResult("Report.\n<usage>total_tokens: 12</usage>\n")).toBe("Report.");
    expect(cleanSubagentResult(null)).toBe("");
  });
});
