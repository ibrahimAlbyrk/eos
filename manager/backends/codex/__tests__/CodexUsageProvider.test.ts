import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCodexUsageProvider, codexUsageWindows, codexPlanLabel, CODEX_NOT_SIGNED_IN } from "../CodexUsageProvider.ts";
import { fakeAppServer } from "./fakeAppServer.ts";

const at = (sec: number) => new Date(sec * 1000).toISOString();

describe("codexUsageWindows", () => {
  it("puts each window in the slot of its length", () => {
    const w = codexUsageWindows({
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_000 },
      secondary: { usedPercent: 39, windowDurationMins: 10080, resetsAt: 2_000 },
    });
    assert.deepEqual(w, { fiveHour: { utilization: 12, resetsAt: at(1_000) }, sevenDay: { utilization: 39, resetsAt: at(2_000) } });
  });

  it("a weekly-only plan fills just the weekly slot; unusable windows are skipped", () => {
    assert.deepEqual(codexUsageWindows({ primary: { usedPercent: 39, windowDurationMins: 10080, resetsAt: 5 }, secondary: null }), {
      fiveHour: null, sevenDay: { utilization: 39, resetsAt: at(5) },
    });
    assert.deepEqual(codexUsageWindows({ primary: { usedPercent: 10 } }), { fiveHour: null, sevenDay: null });
    assert.deepEqual(codexUsageWindows(null), { fiveHour: null, sevenDay: null });
  });

  it("clamps to 0–100", () => {
    assert.equal(codexUsageWindows({ primary: { usedPercent: 140, windowDurationMins: 300, resetsAt: 1 } }).fiveHour?.utilization, 100);
  });
});

describe("codexPlanLabel", () => {
  it("reads naturally", () => {
    assert.equal(codexPlanLabel("prolite"), "Pro Lite");
    assert.equal(codexPlanLabel("plus"), "Plus");
    assert.equal(codexPlanLabel("unknown"), undefined);
    assert.equal(codexPlanLabel(null), undefined);
  });
});

describe("createCodexUsageProvider", () => {
  it("reads the rate limits once and closes the server", async () => {
    const server = fakeAppServer({
      "account/rateLimits/read": () => ({ rateLimits: { planType: "prolite", primary: { usedPercent: 39, windowDurationMins: 10080, resetsAt: 1791059144 }, secondary: null } }),
    });
    const provider = createCodexUsageProvider({
      binary: "/bin/codex", env: () => ({}), signedIn: () => true, open: async () => server, now: () => new Date("2026-09-28T00:00:00Z"),
    });
    assert.deepEqual(await provider.fetchUsage(), {
      provider: "codex",
      plan: "Pro Lite",
      windows: { fiveHour: null, sevenDay: { utilization: 39, resetsAt: at(1791059144) } },
      fetchedAt: "2026-09-28T00:00:00.000Z",
    });
    assert.deepEqual(server.requests.map((r) => r.method), ["account/rateLimits/read"]);
    assert.equal(server.closed, true);
  });

  it("signed out (or no Codex) is the quiet not-signed-in reason, with no server started", async () => {
    let opened = false;
    const open = async () => { opened = true; return fakeAppServer(); };
    await assert.rejects(createCodexUsageProvider({ binary: "/bin/codex", env: () => ({}), signedIn: () => false, open }).fetchUsage(), new RegExp(CODEX_NOT_SIGNED_IN));
    await assert.rejects(createCodexUsageProvider({ binary: null, env: () => ({}), signedIn: () => true, open }).fetchUsage(), new RegExp(CODEX_NOT_SIGNED_IN));
    assert.equal(opened, false);
  });
});
