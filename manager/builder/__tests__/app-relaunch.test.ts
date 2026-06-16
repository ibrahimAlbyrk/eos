import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { decideUiAction } from "../steps/app-relaunch.ts";

const base = { open: false, running: true, bundleStale: false };

describe("decideUiAction", () => {
  it("closed app: nothing to do unless --open", () => {
    assert.equal(decideUiAction({ ...base, running: false }).action, "none");
    assert.equal(decideUiAction({ ...base, running: false, open: true }).action, "open");
  });

  it("bundle change relaunches the running app", () => {
    const plan = decideUiAction({ ...base, bundleStale: true });
    assert.equal(plan.action, "relaunch");
    assert.match(plan.reason, /bundle/);
  });

  it("nothing changed: running app stays untouched", () => {
    assert.equal(decideUiAction(base).action, "none");
  });
});
