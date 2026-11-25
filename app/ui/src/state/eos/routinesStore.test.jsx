import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../api/routes.js";
import { fixtureTransport, setEosTransport } from "./transport.js";
import {
  _resetRoutines, applyRoutineChange, ensureRoutinesLoaded, loadRoutine, refreshRoutines, resyncRoutines, useRoutines,
} from "./routinesStore.js";
import routines from "../../views/eos/gallery/sample/routines.json";
import detail from "../../views/eos/gallery/sample/routine-detail.json";

const PR = detail.routine.id;
const reads = { [ROUTES.routines]: routines, [ROUTES.routine(PR)]: detail };

function recording(paths) {
  const fixture = fixtureTransport(paths);
  return { get: vi.fn(fixture.get), send: vi.fn(fixture.send) };
}

function current() {
  let read;
  function Probe() {
    read = useRoutines();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return read;
}

beforeEach(() => _resetRoutines());
afterEach(() => setEosTransport(null));

describe("the routine list", () => {
  it("is null until it loads, and loads once after the first paint", async () => {
    const t = recording(reads);
    setEosTransport(t);
    expect(current().list).toBeNull();
    ensureRoutinesLoaded();
    ensureRoutinesLoaded();
    await vi.waitFor(() => expect(current().list).toHaveLength(routines.length));
    expect(t.get.mock.calls).toEqual([[ROUTES.routines]]);
  });

  it("says it could not load, and keeps the last list when a later read fails", async () => {
    setEosTransport(fixtureTransport({}));
    await refreshRoutines();
    expect(current()).toMatchObject({ list: null, listFailed: true });
    setEosTransport(fixtureTransport(reads));
    await refreshRoutines();
    setEosTransport(fixtureTransport({}));
    await refreshRoutines();
    expect(current()).toMatchObject({ list: routines, listFailed: false });
  });
});

describe("routine:change", () => {
  it("applies the row it carries as it is, without a read", async () => {
    setEosTransport(fixtureTransport(reads));
    await refreshRoutines();
    await loadRoutine(PR);
    const t = recording(reads);
    setEosTransport(t);

    const paused = { ...routines[0], state: "paused", pausedReason: "spend" };
    applyRoutineChange({ routineId: PR, reason: "state", row: paused });
    expect(current().list[0]).toEqual(paused);
    expect(current().details[PR].routine).toEqual(paused);
    expect(current().details[PR].head).toEqual(detail.head);

    const made = { ...routines[0], id: "rt-new000000001", name: "Inbox Zero" };
    applyRoutineChange({ routineId: made.id, reason: "created", row: made });
    expect(current().list.at(-1)).toEqual(made);
    expect(t.get).not.toHaveBeenCalled();
  });

  it("moves a deleted routine to Recently deleted and drops its detail", async () => {
    setEosTransport(fixtureTransport(reads));
    await refreshRoutines();
    await loadRoutine(PR);
    applyRoutineChange({ routineId: PR, reason: "deleted" });
    expect(current().list.find((r) => r.id === PR).state).toBe("deleted");
    expect(current().details).toEqual({});
    expect(current().failed[PR]).toBe("gone");
  });

  it("changes nothing while nothing is loaded, and ignores a payload without its row", () => {
    applyRoutineChange({ routineId: PR, reason: "stats", row: routines[0] });
    applyRoutineChange({ routineId: PR, reason: "stats" });
    applyRoutineChange(null);
    expect(current()).toMatchObject({ list: null, details: {} });
  });
});

describe("routine details", () => {
  it("keeps the 30 opened last", async () => {
    const many = Array.from({ length: 31 }, (_, i) => ({ ...detail, routine: { ...detail.routine, id: `rt-${String(i).padStart(12, "0")}` } }));
    setEosTransport(fixtureTransport(Object.fromEntries(many.map((d) => [ROUTES.routine(d.routine.id), d]))));
    for (const d of many) await loadRoutine(d.routine.id);
    const kept = Object.keys(current().details);
    expect(kept).toHaveLength(30);
    expect(kept).not.toContain(many[0].routine.id);
    expect(kept.at(-1)).toBe(many[30].routine.id);
  });

  it("says a routine the core does not have is gone, and a failed read is an error", async () => {
    setEosTransport({ get: async () => ({ ok: false, status: 404, body: {} }) });
    await loadRoutine("rt-gone");
    setEosTransport({ get: async () => ({ ok: false, status: 500, body: {} }) });
    await loadRoutine("rt-broken");
    expect(current().failed).toEqual({ "rt-gone": "gone", "rt-broken": "error" });
  });
});

describe("resync", () => {
  it("reads the list and every open detail again, once the list was asked for", async () => {
    const t = recording(reads);
    setEosTransport(t);
    resyncRoutines();
    expect(t.get).not.toHaveBeenCalled();

    ensureRoutinesLoaded();
    await loadRoutine(PR);
    t.get.mockClear();
    resyncRoutines();
    expect(t.get.mock.calls).toEqual([[ROUTES.routines], [ROUTES.routine(PR)]]);
  });
});
