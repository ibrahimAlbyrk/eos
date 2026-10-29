import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { UpdateService, type UpdateServiceDeps } from "../update/UpdateService.ts";
import { UpdateError } from "../../../core/src/domain/update/errors.ts";
import type { StagedUpdate } from "../../../core/src/ports/Updates.ts";
import type { UpdateApply, UpdateNotice, UpdatePointer, UpdateState } from "../../../contracts/src/update.ts";

const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLog; } };
const install = { version: "0.1.2", root: "/Applications/Eos.app", platform: "darwin-arm64" as const };
const pointer = (version = "0.1.3"): UpdatePointer => ({
  version, platform: "darwin-arm64", releasedAt: "2026-10-29T12:00:00.000Z",
  manifest: { path: `releases/${version}/darwin-arm64.manifest.json.zst`, sha256: "a".repeat(64), size: 10 },
});
const stagedOf = (version = "0.1.3"): StagedUpdate => ({ version, path: `/u/staged/${version}/Eos.app`, bytes: 800_000, full: 230_000_000, notes: "# notes" });

function harness(opts: {
  offer?: UpdatePointer | null;
  autoDownload?: boolean;
  staged?: StagedUpdate | null;
  result?: { notice: UpdateNotice; dismissed: boolean } | null;
  lastVersion?: string | null;
  random?: () => number;
  download?: UpdateServiceDeps["download"];
  verifyStaged?: UpdateServiceDeps["verifyStaged"];
} = {}) {
  const states: UpdateState[] = [];
  const applies: UpdateApply[] = [];
  let agents = 0;
  let auto = opts.autoDownload ?? true;
  let offer = opts.offer === undefined ? pointer() : opts.offer;
  let staged = opts.staged ?? null;
  let now = 1_000;
  let checks = 0;
  const svc = new UpdateService({
    install,
    off: null,
    check: async () => { checks++; return offer; },
    download: opts.download ?? (async (input) => {
      input.onProgress(0, 800_000);
      input.onProgress(800_000, 800_000);
      input.onStaging?.();
      staged = stagedOf(input.pointer.version);
      return staged;
    }),
    verifyStaged: opts.verifyStaged ?? (async () => {}),
    workspace: {
      staged: async () => staged,
      clear: async () => { staged = null; },
      result: async () => opts.result ?? null,
      dismissResult: async () => {},
      lastVersion: async () => opts.lastVersion ?? null,
      setLastVersion: async () => {},
    },
    autoDownload: () => auto,
    workingAgents: () => agents,
    bus: {
      publish: (topic, payload) => {
        if (topic === "update:change") states.push(payload as UpdateState);
        else applies.push(payload as UpdateApply);
      },
    },
    clock: { now: () => now },
    log: noopLog,
    random: opts.random,
  });
  return {
    svc, states, applies,
    checks: () => checks,
    advance: (ms: number) => { now += ms; },
    phases: () => states.map((s) => s.status.phase),
    setAgents: (n: number) => { agents = n; },
    setAuto: (v: boolean) => { auto = v; },
    setOffer: (p: UpdatePointer | null) => { offer = p; },
  };
}

const settle = () => new Promise((r) => setImmediate(r));

describe("UpdateService", () => {
  it("checks, downloads in the background and becomes ready", async () => {
    const h = harness();
    await h.svc.check();
    assert.deepEqual([...new Set(h.phases())], ["checking", "downloading", "staging", "ready"]);
    const ready = h.svc.state();
    assert.equal(ready.status.version, "0.1.3");
    assert.equal(ready.status.bytes, 800_000);
    assert.equal(ready.notes, "# notes");
    assert.equal(ready.lastCheckedAt, 1_000);
  });

  it("only offers the release when auto-download is off, and fetches it on request", async () => {
    const h = harness({ autoDownload: false });
    await h.svc.check();
    assert.equal(h.svc.state().status.phase, "available");
    await h.svc.download();
    assert.equal(h.svc.state().status.phase, "ready");
  });

  it("stays idle when nothing newer is out", async () => {
    const h = harness({ offer: null });
    await h.svc.check();
    assert.deepEqual(h.phases(), ["checking", "idle"]);
  });

  it("restarts now: re-verifies, then hands the staged app to the shell", async () => {
    const h = harness();
    await h.svc.check();
    assert.equal(h.svc.restart("now"), true);
    await settle();
    assert.equal(h.svc.state().status.phase, "applying");
    assert.deepEqual(h.applies, [{ version: "0.1.3", from: "0.1.2", staged: "/u/staged/0.1.3/Eos.app", target: "/Applications/Eos.app" }]);
  });

  it("waits for working agents, then applies on its own", async () => {
    const h = harness();
    await h.svc.check();
    h.setAgents(2);
    assert.equal(h.svc.restart("idle"), true);
    assert.equal(h.svc.state().status.phase, "waiting");
    assert.equal(h.svc.state().status.agents, 2);
    h.setAgents(1);
    h.svc.agentsChanged();
    assert.equal(h.svc.state().status.agents, 1);
    h.setAgents(0);
    h.svc.agentsChanged();
    await settle();
    assert.equal(h.applies.length, 1);
  });

  it("goes back to ready when waiting is called off", async () => {
    const h = harness();
    await h.svc.check();
    h.setAgents(1);
    h.svc.restart("idle");
    h.svc.later();
    assert.equal(h.svc.state().status.phase, "ready");
    assert.equal(h.svc.restart("now"), true);
  });

  it("refuses a staged app that no longer verifies and starts over", async () => {
    const h = harness({ verifyStaged: async () => { throw new UpdateError("rejected-bundle", "signature broke"); } });
    await h.svc.check();
    h.svc.restart("now");
    await settle();
    assert.equal(h.svc.state().status.phase, "error");
    assert.equal(h.applies.length, 0);
    assert.equal(h.svc.restart("now"), false);
  });

  it("reports a failed download and recovers on the next check", async () => {
    let fail = true;
    const h = harness({
      download: async (input) => {
        if (fail) throw new UpdateError("network", "offline");
        input.onStaging?.();
        return stagedOf(input.pointer.version);
      },
    });
    await h.svc.check();
    assert.equal(h.svc.state().status.phase, "error");
    assert.equal(h.svc.state().status.error, "offline");
    fail = false;
    await h.svc.check();
    assert.equal(h.svc.state().status.phase, "ready");
  });

  it("stops a download when auto-download is switched off", async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => { started = r; });
    const h = harness({
      download: (_input, signal) => new Promise((_resolve, reject) => {
        started();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    });
    const check = h.svc.check();
    await running;
    h.setAuto(false);
    h.svc.settingsChanged();
    await check;
    assert.equal(h.svc.state().status.phase, "available");
  });

  it("picks up a version staged before the daemon restarted, and shows how the last swap ended", async () => {
    const h = harness({
      staged: stagedOf("0.1.3"),
      result: { notice: { kind: "rolled-back", version: "0.1.3", from: "0.1.2" }, dismissed: false },
      autoDownload: true,
    });
    await h.svc.start();
    h.svc.stop();
    assert.equal(h.svc.state().status.phase, "ready");
    assert.deepEqual(h.svc.state().notice, { kind: "rolled-back", version: "0.1.3", from: "0.1.2" });
    await h.svc.dismissNotice();
    assert.equal(h.svc.state().notice, null);
  });

  it("never fetches a rolled-back version on its own", async () => {
    const h = harness({ result: { notice: { kind: "rolled-back", version: "0.1.3", from: "0.1.2" }, dismissed: true } });
    await h.svc.start();
    h.svc.stop();
    await h.svc.check();
    assert.equal(h.svc.state().status.phase, "available");
    h.setOffer(pointer("0.1.4"));
    await h.svc.check();
    assert.equal(h.svc.state().status.phase, "ready");
  });

  it("says it was updated when a newer version runs than last time", async () => {
    const h = harness({ lastVersion: "0.1.1", offer: null });
    await h.svc.start();
    h.svc.stop();
    assert.deepEqual(h.svc.state().notice, { kind: "updated", version: "0.1.2", from: "0.1.1" });
    const same = harness({ lastVersion: "0.1.2", offer: null });
    await same.svc.start();
    same.svc.stop();
    assert.equal(same.svc.state().notice, null);
  });

  it("looks when Eos opens or the Mac wakes, unless it looked minutes ago", async () => {
    const h = harness({ offer: null });
    await h.svc.check("opened");
    await h.svc.check("woke");
    assert.equal(h.checks(), 1);
    await h.svc.check("manual");
    assert.equal(h.checks(), 2, "Check now always looks");
    h.advance(11 * 60_000);
    await h.svc.check("opened");
    assert.equal(h.checks(), 3);
    h.svc.stop();
  });

  it("runs one check when two nudges arrive together", async () => {
    const h = harness({ offer: null });
    await Promise.all([h.svc.check("opened"), h.svc.check("opened"), h.svc.check("manual")]);
    assert.equal(h.checks(), 1);
    h.svc.stop();
  });

  it("checks soon after start, then about every half hour", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const h = harness({ offer: null, random: () => 0 });
      await h.svc.start();
      mock.timers.tick(30_000);
      await settle();
      assert.equal(h.checks(), 1);
      mock.timers.tick(24 * 60_000 - 1);
      await settle();
      assert.equal(h.checks(), 1, "−20% jitter: not before 24 min");
      mock.timers.tick(1);
      await settle();
      assert.equal(h.checks(), 2);
      h.svc.stop();
    } finally {
      mock.timers.reset();
    }
  });

  it("is off for a build from source", () => {
    const svc = new UpdateService({ ...harnessDeps(), install: null, off: "dev-build" });
    assert.equal(svc.state().status.phase, "off");
    assert.equal(svc.state().status.off, "dev-build");
    assert.equal(svc.state().current, null);
  });
});

function harnessDeps(): UpdateServiceDeps {
  return {
    install, off: null, check: async () => null, download: async () => stagedOf(), verifyStaged: async () => {},
    workspace: {
      staged: async () => null, clear: async () => {}, result: async () => null, dismissResult: async () => {},
      lastVersion: async () => null, setLastVersion: async () => {},
    },
    autoDownload: () => true, workingAgents: () => 0, bus: { publish: () => {} }, clock: { now: () => 0 }, log: noopLog,
  };
}
