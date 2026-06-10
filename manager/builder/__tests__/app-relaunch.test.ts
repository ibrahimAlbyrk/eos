import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { decideUiAction } from "../steps/app-relaunch.ts";

const base = { open: false, running: true, bundleStale: false, webApplied: false, reloadSubscribers: null };

describe("decideUiAction", () => {
  it("closed app: nothing to do unless --open", () => {
    assert.equal(decideUiAction({ ...base, running: false }).action, "none");
    assert.equal(decideUiAction({ ...base, running: false, open: true }).action, "open");
  });

  it("bundle change always relaunches, even when a reload landed", () => {
    const plan = decideUiAction({ ...base, bundleStale: true, webApplied: true, reloadSubscribers: 2 });
    assert.equal(plan.action, "relaunch");
    assert.match(plan.reason, /bundle/);
  });

  it("web rebuild with a delivered reload needs no relaunch", () => {
    const plan = decideUiAction({ ...base, webApplied: true, reloadSubscribers: 1 });
    assert.equal(plan.action, "none");
    assert.match(plan.reason, /reloaded in place \(1 client\)/);
  });

  it("web rebuild with no reload taker falls back to relaunch", () => {
    assert.equal(decideUiAction({ ...base, webApplied: true, reloadSubscribers: 0 }).action, "relaunch");
    assert.equal(decideUiAction({ ...base, webApplied: true, reloadSubscribers: null }).action, "relaunch");
  });

  it("nothing changed: running app stays untouched", () => {
    assert.equal(decideUiAction(base).action, "none");
  });
});
