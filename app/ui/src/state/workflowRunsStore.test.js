import { describe, it, expect, vi, beforeEach } from "vitest";

const getWorkflowRun = vi.fn();
const stopWorkflowRun = vi.fn();
vi.mock("../api/client.js", () => ({
  api: {
    getWorkflowRun: (...a) => getWorkflowRun(...a),
    stopWorkflowRun: (...a) => stopWorkflowRun(...a),
  },
}));

const store = await import("./workflowRunsStore.js");

const snapshot = { phases: [], agents: [], logs: [] };
const progress = (o) => ({ workerId: "w-1", callId: "c1", taskId: "t1", status: "running", snapshot, updatedAt: 1, ...o });
const detail = (status) => ({ callId: "c1", taskId: "t1", status, snapshot, canStop: status === "running" });

beforeEach(() => {
  store._reset();
  getWorkflowRun.mockReset();
  stopWorkflowRun.mockReset();
});

describe("workflowRunsStore", () => {
  it("keeps a run's latest live snapshot", () => {
    store.applyWorkflowProgress(progress({ updatedAt: 1 }));
    store.applyWorkflowProgress(progress({ updatedAt: 2 }));
    expect(store.getWorkflowRun("w-1", "c1").live.updatedAt).toBe(2);
    expect(getWorkflowRun).not.toHaveBeenCalled();
  });

  it("a run's end fetches what only the daemon has", async () => {
    getWorkflowRun.mockResolvedValue(detail("completed"));
    store.applyWorkflowProgress(progress({ status: "completed" }));
    await vi.waitFor(() => expect(store.getWorkflowRun("w-1", "c1").detail?.status).toBe("completed"));
    expect(getWorkflowRun).toHaveBeenCalledWith("w-1", "c1");
  });

  it("fetches once unless forced, and remembers an unknown run as such", async () => {
    getWorkflowRun.mockResolvedValue(null);
    await Promise.all([store.fetchWorkflowRun("w-1", "c1"), store.fetchWorkflowRun("w-1", "c1")]);
    await store.fetchWorkflowRun("w-1", "c1");
    expect(getWorkflowRun).toHaveBeenCalledTimes(1);
    expect(store.getWorkflowRun("w-1", "c1")).toMatchObject({ fetched: true, detail: null });
    await store.fetchWorkflowRun("w-1", "c1", { force: true });
    expect(getWorkflowRun).toHaveBeenCalledTimes(2);
  });

  it("counts a conversation's running runs and refetches only those on resync", async () => {
    getWorkflowRun.mockImplementation(async (_w, c) => detail(c === "c1" ? "running" : "completed"));
    await store.fetchWorkflowRun("w-1", "c1");
    await store.fetchWorkflowRun("w-1", "c2");
    expect(store.runningWorkflowCount("w-1")).toBe(1);
    expect(store.runningWorkflowCount("w-2")).toBe(0);
    getWorkflowRun.mockClear();
    store.resyncWorkflowRuns();
    expect(getWorkflowRun.mock.calls).toEqual([["w-1", "c1"]]);
  });

  it("a refused stop surfaces the daemon's reason", async () => {
    stopWorkflowRun.mockResolvedValue({ ok: false, status: 409, body: { error: "this session can't stop a workflow" } });
    await expect(store.stopWorkflowRun("w-1", "c1")).rejects.toThrow("this session can't stop a workflow");
  });
});
