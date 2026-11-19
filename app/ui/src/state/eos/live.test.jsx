import { describe, it, expect, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../api/routes.js";
import { fixtureTransport, setEosTransport } from "./transport.js";
import { applyEosEvent, EOS_TOPICS, resyncEos } from "./live.js";
import { _resetCapabilities, ensureCapabilitiesLoaded } from "./capabilitiesStore.js";
import { _resetInbox, ensureInboxLoaded } from "./inboxStore.js";
import { _resetRoutines, ensureRoutinesLoaded, refreshRoutines, useRoutines } from "./routinesStore.js";
import { _resetRuns, useRuns } from "./runsStore.js";
import routines from "../../views/eos/gallery/sample/routines.json";

afterEach(() => {
  setEosTransport(null);
  _resetRoutines();
  _resetRuns();
  _resetInbox();
  _resetCapabilities();
});

describe("Eos's live topics", () => {
  it("are the whole registry", () => {
    expect(EOS_TOPICS).toEqual([
      "routine:change", "run:change", "runs:active", "run:activity", "signals:change", "inbox:change", "inbox:delivery",
      "inbox:freedom", "inbox:halt", "memory:change", "memory:recalled", "surfaces:change", "surfaces:issue",
      "surfaces:pins", "surfaces:design", "actions:record", "capabilities:change",
    ]);
  });

  it("are every one taken, so none falls through to the workers refetch, even with nothing loaded", () => {
    const get = vi.fn();
    setEosTransport({ get, send: vi.fn() });
    for (const topic of EOS_TOPICS) expect(applyEosEvent(topic, { id: "x", routineId: "rt-x", runId: "rn-x" }), topic).toBe(true);
    for (const topic of EOS_TOPICS) expect(applyEosEvent(topic, undefined), topic).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it("leave every other topic to useLive", () => {
    for (const topic of ["worker:change", "jobs:change", "state:patch", "plugin:x:y", "routines:change"]) {
      expect(applyEosEvent(topic, {})).toBe(false);
    }
  });

  it("reach their store", async () => {
    setEosTransport(fixtureTransport({ [ROUTES.routines]: routines }));
    await refreshRoutines();
    const row = { ...routines[0], name: "PR Review, renamed" };
    applyEosEvent("routine:change", { routineId: row.id, reason: "version", row });
    applyEosEvent("runs:active", { count: 2, needsUser: 1 });
    let seen;
    function Probe() {
      seen = { routines: useRoutines(), runs: useRuns() };
      return null;
    }
    renderToStaticMarkup(<Probe />);
    expect(seen.routines.list[0]).toEqual(row);
    expect(seen.runs.active).toEqual({ count: 2, needsUser: 1 });
  });
});

describe("resync", () => {
  it("reads again only what was loaded", async () => {
    const get = vi.fn(async () => ({ ok: true, status: 200, body: [] }));
    setEosTransport({ get, send: vi.fn() });
    resyncEos();
    expect(get).not.toHaveBeenCalled();

    ensureRoutinesLoaded();
    ensureInboxLoaded();
    ensureCapabilitiesLoaded();
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    get.mockClear();
    resyncEos();
    expect(get.mock.calls.map(([path]) => path).sort()).toEqual([ROUTES.capabilities, ROUTES.inbox, ROUTES.routines].sort());
  });
});
