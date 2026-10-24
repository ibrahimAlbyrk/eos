import { describe, expect, it } from "vitest";
import { filterJobs, groupBySource, hasUnseenFailure, jobMeta, pctOf, sortJobs, titleIsCommand } from "./jobs.js";

const job = (over) => ({
  id: "x", kind: "shell", status: "running", workerId: "w1", title: "t", command: null, detail: null,
  startedAt: 0, endedAt: null, progress: null, exitCode: null, callId: null, hasOutput: false, canStop: false, ...over,
});

describe("jobs model", () => {
  it("orders running first by start, then finished by end", () => {
    const sorted = sortJobs([
      job({ id: "f1", status: "completed", endedAt: 5 }),
      job({ id: "r1", startedAt: 1 }),
      job({ id: "f2", status: "failed", endedAt: 9 }),
      job({ id: "r2", startedAt: 3 }),
    ]);
    expect(sorted.map((j) => j.id)).toEqual(["r2", "r1", "f2", "f1"]);
  });

  it("filters by kind group", () => {
    const jobs = [job({ id: "a", kind: "shell" }), job({ id: "b", kind: "monitor" }), job({ id: "c", kind: "workflow" }), job({ id: "d", kind: "transfer", workerId: null })];
    expect(filterJobs(jobs, "all")).toHaveLength(4);
    expect(filterJobs(jobs, "shells").map((j) => j.id)).toEqual(["a", "b"]);
    expect(filterJobs(jobs, "agents").map((j) => j.id)).toEqual(["c"]);
    expect(filterJobs(jobs, "eos").map((j) => j.id)).toEqual(["d"]);
  });

  it("groups by chat, Eos for its own work, in the jobs' order", () => {
    const groups = groupBySource([job({ id: "a", workerId: "w2" }), job({ id: "b", workerId: null }), job({ id: "c", workerId: "w2" })], (id) => `chat ${id}`);
    expect(groups.map((g) => [g.label, g.jobs.map((j) => j.id)])).toEqual([["chat w2", ["a", "c"]], ["Eos", ["b"]]]);
  });

  it("shows elapsed or share done while running, time ago once finished", () => {
    expect(jobMeta(job({ startedAt: 0 }), 724_000)).toBe("12:04");
    expect(jobMeta(job({ kind: "transfer", progress: { done: 64, total: 100 } }), 1)).toBe("64%");
    expect(jobMeta(job({ kind: "workflow", progress: { done: 1, total: 3 }, startedAt: 0 }), 61_000)).toBe("01:01");
    expect(jobMeta(job({ status: "completed", endedAt: 0 }), 120_000)).toBe("2m ago");
    expect(jobMeta(job({ status: "completed", endedAt: 0 }), 10_000)).toBe("just now");
  });

  it("reads percentages, commands and unseen failures", () => {
    expect(pctOf(job({ progress: { done: 1, total: 3 } }))).toBe(33);
    expect(pctOf(job({}))).toBe(null);
    expect(titleIsCommand(job({ title: "npm test", command: "npm test" }))).toBe(true);
    expect(titleIsCommand(job({ title: "Run tests", command: "npm test" }))).toBe(false);
    expect(hasUnseenFailure([job({ status: "failed", endedAt: 10 })], 5)).toBe(true);
    expect(hasUnseenFailure([job({ status: "failed", endedAt: 10 })], 10)).toBe(false);
  });
});
