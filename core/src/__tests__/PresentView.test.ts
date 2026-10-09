import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { GenuiRejectedError, GENUI_APPS_OFF_TEXT, presentApp, presentView, type GenuiSwitches, type PresentViewDeps } from "../use-cases/PresentView.ts";
import { PermissionDeniedError, ValidationError } from "../errors/index.ts";
import { validateView } from "../../../contracts/src/genui/catalog.ts";
import { GENUI_OFF_TEXT, VIEW_ID_RE, newViewId, validateApp, type ViewRecord } from "../../../contracts/src/genui/index.ts";

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../../../contracts/src/__tests__/fixtures/genui/${name}.json`, import.meta.url), "utf8"));

function makeDeps(over: Partial<GenuiSwitches> = {}, ids?: string[]) {
  const saved = new Map<string, ViewRecord>();
  const switches: GenuiSwitches = { level: "balanced", apps: true, ...over };
  const queue = ids ? [...ids] : null;
  const deps: PresentViewDeps = {
    views: { save: (v) => { saved.set(v.id, v); }, get: (id) => saved.get(id) ?? null },
    clock: { now: () => 1_700_000_000_000 },
    newId: () => (queue ? queue.shift()! : newViewId()),
    validateView,
    validateApp,
    settings: () => switches,
  };
  return { deps, saved, switches };
}

const SMALL = {
  title: "Two places",
  data: { places: [{ id: 1, type: "Place", name: "Çiya", rating: 4.6 }, { id: 2, type: "Place", name: "Datlı Maya", rating: 4.4 }] },
  ui: '<List of="places"/>',
  summary: "Çiya and Datlı Maya.",
};

describe("presentView", () => {
  it("stores every scenario board under a fresh view id", () => {
    for (const name of ["restaurants", "trip", "tests", "learn"]) {
      const { deps, saved } = makeDeps();
      const r = presentView(deps, "orch-1", fixture(name));
      assert.match(r.viewId, VIEW_ID_RE, name);
      assert.deepEqual(r.warnings, [], name);
      const rec = saved.get(r.viewId)!;
      assert.equal(rec.kind, "view");
      assert.equal(rec.workerId, "orch-1");
      assert.equal(rec.createdAt, 1_700_000_000_000);
      assert.equal(rec.title, fixture(name).title);
    }
  });

  it("returns the stats the success line is built from", () => {
    const { deps } = makeDeps();
    const r = presentView(deps, "orch-1", fixture("restaurants"));
    const places = r.stats.collections.find((c) => c.name === "places");
    assert.equal(places?.count, 6);
    assert.equal(places?.type, "Place");
    assert.equal(r.stats.maps, 1);
  });

  it("refuses with every problem and its path, and stores nothing", () => {
    const { deps, saved } = makeDeps();
    const bad = { ...SMALL, summary: "", data: { places: [{ id: 1, type: "Place", name: "X", rating: 6.2 }] } };
    assert.throws(() => presentView(deps, "orch-1", bad), (e: unknown) => {
      assert.ok(e instanceof GenuiRejectedError);
      assert.ok(e instanceof ValidationError, "maps to 400");
      const paths = e.problems.map((p) => p.path);
      assert.ok(paths.includes("summary"), paths.join());
      assert.ok(paths.includes("data.places[0].rating"), paths.join());
      assert.match(e.message, /^2 problems — nothing rendered/);
      assert.match(e.message, /data\.places\[0\]\.rating: 6\.2 is outside 0–5/);
      return true;
    });
    assert.equal(saved.size, 0);
  });

  it("answers in text when the user turned visual answers off", () => {
    const { deps, saved } = makeDeps({ level: "text" });
    assert.throws(() => presentView(deps, "orch-1", SMALL), (e: unknown) => e instanceof PermissionDeniedError && e.message === GENUI_OFF_TEXT);
    assert.equal(saved.size, 0);
  });

  it("keeps only the tool's own fields", () => {
    const { deps, saved } = makeDeps();
    const r = presentView(deps, "orch-1", { ...SMALL, extra: "x" });
    assert.ok(r.warnings.some((w) => w.path === "extra"));
    assert.deepEqual(Object.keys(saved.get(r.viewId)!.spec).sort(), ["data", "summary", "title", "ui"]);
  });

  it("warns when replaces names a view that isn't the caller's", () => {
    const { deps } = makeDeps();
    const first = presentView(deps, "orch-1", SMALL);
    const mine = presentView(deps, "orch-1", { ...SMALL, replaces: first.viewId });
    assert.deepEqual(mine.warnings, []);
    const theirs = presentView(deps, "orch-2", { ...SMALL, replaces: first.viewId });
    assert.deepEqual(theirs.warnings.map((w) => w.path), ["replaces"]);
    const unknown = presentView(deps, "orch-1", { ...SMALL, replaces: "v_AAAAAAAAAAAA" });
    assert.match(unknown.warnings[0]!.message, /v_AAAAAAAAAAAA is not one of your views/);
  });

  it("never reuses an id that is already taken", () => {
    const { deps } = makeDeps({}, ["v_aaaaaaaaaaaa", "v_aaaaaaaaaaaa", "v_bbbbbbbbbbbb"]);
    assert.equal(presentView(deps, "w", SMALL).viewId, "v_aaaaaaaaaaaa");
    assert.equal(presentView(deps, "w", SMALL).viewId, "v_bbbbbbbbbbbb");
  });
});

describe("presentApp", () => {
  it("stores an app", () => {
    const { deps, saved } = makeDeps();
    const r = presentApp(deps, "focus-1", fixture("app"));
    assert.match(r.viewId, VIEW_ID_RE);
    const rec = saved.get(r.viewId)!;
    assert.equal(rec.kind, "app");
    assert.equal(rec.kind === "app" && rec.spec.height, 460);
  });

  it("is refused while apps are off, and while visual answers are off", () => {
    assert.throws(() => presentApp(makeDeps({ apps: false }).deps, "w", fixture("app")), (e: unknown) => e instanceof PermissionDeniedError && e.message === GENUI_APPS_OFF_TEXT);
    assert.throws(() => presentApp(makeDeps({ level: "text" }).deps, "w", fixture("app")), (e: unknown) => e instanceof PermissionDeniedError && e.message === GENUI_OFF_TEXT);
  });

  it("refuses an oversized or empty document with paths", () => {
    const { deps, saved } = makeDeps();
    const big = { title: "Big", summary: "s", html: `<div>${"x".repeat(270_000)}</div>` };
    assert.throws(() => presentApp(deps, "w", big), (e: unknown) => e instanceof GenuiRejectedError && e.problems[0]!.path === "html");
    assert.throws(() => presentApp(deps, "w", { title: "", summary: "s", html: "" }), (e: unknown) => {
      assert.ok(e instanceof GenuiRejectedError);
      assert.deepEqual(e.problems.map((p) => p.path).sort(), ["html", "title"]);
      return true;
    });
    assert.equal(saved.size, 0);
  });
});
