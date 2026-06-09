import { describe, it, expect } from "vitest";
import { deriveVerdict, deriveChildVerdicts } from "./verdict.js";

const asst = (text, ts) => ({ type: "jsonl", ts, payload: JSON.stringify({ kind: "assistant_text", text }) });
const toolUse = (name, ts) => ({ type: "jsonl", ts, payload: JSON.stringify({ kind: "tool_use", id: "t" + ts, name }) });

describe("deriveVerdict", () => {
  it("defaults to unverified", () => {
    expect(deriveVerdict([]).verdict).toBe("unverified");
    expect(deriveVerdict([asst("hello", 1)]).verdict).toBe("unverified");
  });

  it("parses verify report lines and keeps the command", () => {
    const v = deriveVerdict([asst("verify: npm test -> passed", 10)]);
    expect(v.verdict).toBe("passed");
    expect(v.command).toBe("npm test");
  });

  it("worst verdict wins within one report", () => {
    const v = deriveVerdict([
      asst("verify: npm run build -> passed\nverify: npm test -> failed — 2 specs", 10),
    ]);
    expect(v.verdict).toBe("failed");
  });

  it("parses Handover lines", () => {
    const v = deriveVerdict([
      asst("result: done\nHandover: branch eos-x; verified by npm test: passed; to try: npm run dev", 10),
    ]);
    expect(v.verdict).toBe("passed");
  });

  it("later verdict supersedes earlier one", () => {
    const v = deriveVerdict([
      asst("verify: npm test -> failed", 10),
      asst("verify: npm test -> passed", 20),
    ]);
    expect(v.verdict).toBe("passed");
  });

  it("mutating tool after the verdict invalidates it back to unverified", () => {
    const v = deriveVerdict([
      asst("verify: npm test -> passed", 10),
      toolUse("Edit", 20),
    ]);
    expect(v.verdict).toBe("unverified");
  });

  it("read-only tool after the verdict does not invalidate", () => {
    const v = deriveVerdict([
      asst("verify: npm test -> passed", 10),
      toolUse("Read", 20),
    ]);
    expect(v.verdict).toBe("passed");
  });

  it("blocked is recognized as an honest non-run", () => {
    const v = deriveVerdict([asst("verify: npm test -> blocked — missing .env", 10)]);
    expect(v.verdict).toBe("blocked");
  });
});

describe("deriveChildVerdicts", () => {
  const report = (fromWorker, text, ts) => ({
    type: "worker_report", ts,
    payload: JSON.stringify({ text, fromWorker, workerName: fromWorker }),
  });

  it("maps the latest Handover per child from worker_report events", () => {
    const m = deriveChildVerdicts([
      report("w-1", "result: done\nHandover: branch eos-a; verified by npm test (passed); to try: npm run dev", 10),
      report("w-2", "result: done\nHandover: branch eos-b; verified by npm test (failed); to try: x", 11),
      report("w-1", "result: fixed\nHandover: branch eos-a; verified by npm test (failed); to try: x", 20),
    ]);
    expect(m["w-1"].verdict).toBe("failed");
    expect(m["w-2"].verdict).toBe("failed");
  });

  it("reports without verdicts yield no entry", () => {
    const m = deriveChildVerdicts([report("w-1", "result: investigated, nothing to change", 10)]);
    expect(m["w-1"]).toBeUndefined();
  });

  it("a later unverified Handover clears the earlier verdict instead of storing one", () => {
    const m = deriveChildVerdicts([
      report("w-1", "Handover: branch eos-a; verified by npm test (passed)", 10),
      report("w-1", "Handover: branch eos-a; verified by nothing — unverified", 20),
    ]);
    expect(m["w-1"]).toBeUndefined();
  });
});
