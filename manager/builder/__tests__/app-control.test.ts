import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isAppStale, parseEtime } from "../app-control.ts";

describe("parseEtime", () => {
  it("parses mm:ss, hh:mm:ss and dd-hh:mm:ss", () => {
    assert.equal(parseEtime("05:09"), (5 * 60 + 9) * 1000);
    assert.equal(parseEtime("21:09:48"), ((21 * 60 + 9) * 60 + 48) * 1000);
    assert.equal(parseEtime("01-21:09:48"), (((24 + 21) * 60 + 9) * 60 + 48) * 1000);
    assert.equal(parseEtime("  00:01 \n"), 1000);
  });

  it("rejects garbage", () => {
    assert.equal(parseEtime(""), null);
    assert.equal(parseEtime("Tue Jun  9 01:40:23 2026"), null);
    assert.equal(parseEtime("12"), null);
  });
});

describe("isAppStale", () => {
  const now = 1_750_000_000_000;

  it("a closed app is never stale", () => {
    assert.equal(isAppStale({ running: false, appStartMs: null, stampMtimes: [now] }), false);
  });

  it("no stamps yet means nothing to compare against", () => {
    assert.equal(isAppStale({ running: true, appStartMs: now, stampMtimes: [] }), false);
  });

  it("started well before the newest stamp → stale", () => {
    assert.equal(
      isAppStale({ running: true, appStartMs: now - 60_000, stampMtimes: [now - 120_000, now] }),
      true,
    );
  });

  it("started after the newest stamp → fresh", () => {
    assert.equal(isAppStale({ running: true, appStartMs: now, stampMtimes: [now - 60_000] }), false);
  });

  it("1s slack absorbs etime granularity right after a relaunch", () => {
    assert.equal(isAppStale({ running: true, appStartMs: now - 500, stampMtimes: [now] }), false);
  });

  it("unknown start time → relaunch (harmless) rather than guess fresh", () => {
    assert.equal(isAppStale({ running: true, appStartMs: null, stampMtimes: [now] }), true);
  });
});
