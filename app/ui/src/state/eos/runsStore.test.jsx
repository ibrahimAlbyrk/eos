import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../api/routes.js";
import { fixtureTransport, setEosTransport } from "./transport.js";
import {
  _resetRuns, applyRunChange, applyRunsActive, ensureRunsActiveLoaded, ensureRunsLoaded, loadMoreRuns, loadRun, loadRuns, resyncRuns, useRuns,
} from "./runsStore.js";
import page from "../../views/eos/gallery/sample/runs-page.json";
import runDetail from "../../views/eos/gallery/sample/run-detail.json";

const PR = runDetail.run.routineId;
const RUN = runDetail.run.id;
const first = `${ROUTES.runs}?routineId=${PR}&limit=50`;

function recording(paths) {
  const fixture = fixtureTransport(paths);
  return { get: vi.fn(fixture.get), send: vi.fn(fixture.send) };
}

function current() {
  let read;
  function Probe() {
    read = useRuns();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return read;
}

const runRow = (n) => ({ ...page.runs[0], id: `rn-${String(n).padStart(12, "0")}`, createdAt: 1763452800000 - n });

beforeEach(() => _resetRuns());
afterEach(() => setEosTransport(null));

describe("a routine's runs", () => {
  it("reads the first page of 50 once, after the first paint", async () => {
    const t = recording({ [first]: page });
    setEosTransport(t);
    ensureRunsLoaded(PR);
    expect(current().pages[PR]).toEqual({ runs: null, nextBefore: null, failed: false });
    ensureRunsLoaded(PR);
    await vi.waitFor(() => expect(current().pages[PR].runs).toEqual(page.runs));
    expect(t.get.mock.calls).toEqual([[first]]);
  });

  it("adds the next page after the last, and stops on the last", async () => {
    const one = Array.from({ length: 50 }, (_, i) => runRow(i));
    const two = [runRow(50)];
    const before = one[49].createdAt;
    setEosTransport(fixtureTransport({
      [first]: { runs: one, nextBefore: before },
      [`${ROUTES.runs}?routineId=${PR}&limit=50&before=${before}`]: { runs: two },
    }));
    await loadRuns(PR);
    await loadMoreRuns(PR);
    expect(current().pages[PR].runs).toEqual([...one, ...two]);
    expect(current().pages[PR].nextBefore).toBeNull();
  });

  it("says a page could not load, keeping the rows it had", async () => {
    setEosTransport(fixtureTransport({ [first]: page }));
    await loadRuns(PR);
    setEosTransport(fixtureTransport({}));
    await loadRuns(PR);
    expect(current().pages[PR]).toEqual({ runs: page.runs, nextBefore: null, failed: true });
  });
});

describe("run:change", () => {
  it("reads that one run again and puts its row in its routine's page", async () => {
    setEosTransport(fixtureTransport({ [first]: page }));
    await loadRuns(PR);
    const running = { ...runDetail, run: { ...runDetail.run, state: "running" } };
    const t = recording({ [ROUTES.run(RUN)]: running });
    setEosTransport(t);

    applyRunChange({ runId: RUN, routineId: PR, state: "running" });
    await vi.waitFor(() => expect(current().pages[PR].runs[0].state).toBe("running"));
    expect(t.get.mock.calls).toEqual([[ROUTES.run(RUN)]]);
    // Only a run opened keeps its detail.
    expect(current().details).toEqual({});
  });

  it("puts a new run first in its page, and keeps an opened run's detail current", async () => {
    const fresh = { ...runDetail, run: { ...runDetail.run, id: "rn-new000000001", state: "queued" } };
    setEosTransport(fixtureTransport({ [first]: page, [ROUTES.run(RUN)]: runDetail, [ROUTES.run(fresh.run.id)]: fresh }));
    await loadRuns(PR);
    await loadRun(RUN);
    applyRunChange({ runId: fresh.run.id, routineId: PR, state: "queued" });
    await vi.waitFor(() => expect(current().pages[PR].runs.map((r) => r.id)).toEqual([fresh.run.id, RUN]));

    setEosTransport(fixtureTransport({ [ROUTES.run(RUN)]: { ...runDetail, attempt: 2 } }));
    applyRunChange({ runId: RUN, routineId: PR, state: "running" });
    await vi.waitFor(() => expect(current().details[RUN].attempt).toBe(2));
  });

  it("reads nothing for a run no loaded page or detail would show", () => {
    const t = recording({});
    setEosTransport(t);
    applyRunChange({ runId: RUN, routineId: PR, state: "done" });
    expect(t.get).not.toHaveBeenCalled();
  });
});

describe("run details", () => {
  it("keeps the 20 opened last", async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ ...runDetail, run: runRow(i) }));
    setEosTransport(fixtureTransport(Object.fromEntries(many.map((d) => [ROUTES.run(d.run.id), d]))));
    for (const d of many) await loadRun(d.run.id);
    const kept = Object.keys(current().details);
    expect(kept).toHaveLength(20);
    expect(kept).not.toContain(many[0].run.id);
  });

  it("says a run the core does not have is gone", async () => {
    setEosTransport(fixtureTransport({}));
    await loadRun("rn-gone");
    expect(current().failed["rn-gone"]).toBe("gone");
  });
});

describe("runs:active", () => {
  it("keeps the count and how many wait for the user", () => {
    expect(current().active).toBeNull();
    applyRunsActive({ count: 2, needsUser: 1 });
    expect(current().active).toEqual({ count: 2, needsUser: 1 });
    applyRunsActive({});
    expect(current().active).toEqual({ count: 2, needsUser: 1 });
  });

  it("reads the count once at start and again on resync", async () => {
    const t = recording({ [ROUTES.runsActive]: { count: 3, needsUser: 2 } });
    setEosTransport(t);
    resyncRuns();
    expect(t.get).not.toHaveBeenCalled();
    ensureRunsActiveLoaded();
    ensureRunsActiveLoaded();
    await vi.waitFor(() => expect(current().active).toEqual({ count: 3, needsUser: 2 }));
    expect(t.get.mock.calls).toEqual([[ROUTES.runsActive]]);
    resyncRuns();
    expect(t.get.mock.calls).toEqual([[ROUTES.runsActive], [ROUTES.runsActive]]);
  });
});

describe("resync", () => {
  it("reads every loaded page and open run again", async () => {
    setEosTransport(fixtureTransport({ [first]: page, [ROUTES.run(RUN)]: runDetail }));
    await loadRuns(PR);
    await loadRun(RUN);
    const t = recording({ [first]: page, [ROUTES.run(RUN)]: runDetail });
    setEosTransport(t);
    resyncRuns();
    expect(t.get.mock.calls).toEqual([[first], [ROUTES.run(RUN)]]);
  });
});
