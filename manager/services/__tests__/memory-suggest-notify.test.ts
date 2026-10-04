import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeMemorySuggestNotify } from "../memory-suggest-notify.ts";
import type { NotificationFire } from "../permission-ask-notify.ts";

function harness(pending: () => number) {
  const fired: NotificationFire[] = [];
  const timers: (() => void)[] = [];
  const notify = makeMemorySuggestNotify({
    pendingCount: pending,
    fire: (n) => fired.push(n),
    now: () => 5,
    schedule: (fn) => timers.push(fn),
  });
  return { notify, fired, timers };
}

const suggested = (id: string) => ({ id, action: "created" as const, status: "suggested" as const, by: "agent" as const });

describe("memory suggestion banner", () => {
  it("a burst becomes one banner counting what still waits", () => {
    let pending = 3;
    const { notify, fired, timers } = harness(() => pending);
    notify(suggested("um-a0000000"));
    notify(suggested("um-b0000000"));
    notify(suggested("um-c0000000"));
    assert.equal(timers.length, 1);
    pending = 2;
    timers[0]!();
    assert.deepEqual(fired, [{ title: "Agents noticed 2 things", body: "Review it before it's remembered.", workerId: "", route: "memory", ts: 5 }]);
  });

  it("nothing left by then → no banner; other changes never arm it", () => {
    const { notify, fired, timers } = harness(() => 0);
    notify({ id: "um-a0000000", action: "approved", status: "active", by: "user" });
    notify({ id: "um-a0000000", action: "created", status: "active", by: "user" });
    assert.equal(timers.length, 0);
    notify(suggested("um-b0000000"));
    timers[0]!();
    assert.deepEqual(fired, []);
  });

  it("re-arms after firing; singular title for one", () => {
    const { notify, fired, timers } = harness(() => 1);
    notify(suggested("um-a0000000"));
    timers[0]!();
    notify(suggested("um-b0000000"));
    assert.equal(timers.length, 2);
    assert.equal(fired[0]!.title, "An agent noticed something");
  });
});
