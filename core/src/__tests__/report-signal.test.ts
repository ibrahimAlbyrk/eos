import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyReport, decideReportDisposition } from "../domain/report-signal.ts";

describe("classifyReport", () => {
  it("matches the three signals on the first line", () => {
    assert.equal(classifyReport("result: shipped it"), "result");
    assert.equal(classifyReport("needs input: which db?"), "needs-input");
    assert.equal(classifyReport("failed: blocked on X"), "failed");
    assert.equal(classifyReport("here is a thing I did"), "unknown");
  });

  it("is case- and whitespace-tolerant, and reads only the first line", () => {
    assert.equal(classifyReport("  RESULT:  done"), "result");
    assert.equal(classifyReport("\tNeeds   Input : y"), "needs-input");
    assert.equal(classifyReport("Failed :z"), "failed");
    assert.equal(classifyReport("result: line one\nfailed: not this line"), "result");
    assert.equal(classifyReport(""), "unknown");
  });
});

describe("decideReportDisposition", () => {
  it("no active loop → always pass", () => {
    for (const signal of ["result", "needs-input", "failed", "unknown"] as const) {
      assert.equal(decideReportDisposition({ signal, loopActive: false }), "pass");
    }
  });

  it("needs-input ALWAYS passes, even with an active loop", () => {
    assert.equal(decideReportDisposition({ signal: "needs-input", loopActive: true }), "pass");
    assert.equal(decideReportDisposition({ signal: "needs-input", loopActive: true, retryOnFailed: true }), "pass");
  });

  it("result / unknown → hold when a loop is active", () => {
    assert.equal(decideReportDisposition({ signal: "result", loopActive: true }), "hold");
    assert.equal(decideReportDisposition({ signal: "unknown", loopActive: true }), "hold");
  });

  it("failed → pass by default, hold only when retryOnFailed", () => {
    assert.equal(decideReportDisposition({ signal: "failed", loopActive: true }), "pass");
    assert.equal(decideReportDisposition({ signal: "failed", loopActive: true, retryOnFailed: true }), "hold");
  });
});
