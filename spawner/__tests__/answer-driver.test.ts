import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildKeySequence, AnswerDriver } from "../answer-driver.ts";

const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const CR = "\r";

// Compact the Step[] into a token string mirroring the probe notation
// (scripts/probe/auq-probe.mjs) so each case reads like its verified sequence.
const tokens = (steps: ReturnType<typeof buildKeySequence>): string =>
  steps
    .map((s) =>
      "key" in s
        ? ({ [DOWN]: "down", [RIGHT]: "right", [CR]: "enter" }[s.key] ?? JSON.stringify(s.key))
        : `text:${s.text}`,
    )
    .join(",");

describe("buildKeySequence — verified against claude 2.1.168 probe results", () => {
  it("single-select, option 1 (Apple) → enter", () => {
    assert.equal(tokens(buildKeySequence([{ multiSelect: false, optionCount: 3, picks: [0] }])), "enter");
  });

  it("single-select, option 2 (Banana) → down,enter", () => {
    assert.equal(tokens(buildKeySequence([{ multiSelect: false, optionCount: 3, picks: [1] }])), "down,enter");
  });

  it("single-select free text → down×N, type, enter", () => {
    assert.equal(
      tokens(buildKeySequence([{ multiSelect: false, optionCount: 2, picks: [], freeText: "HelloThere" }])),
      "down,down,text:HelloThere,enter",
    );
  });

  it("multi-select Apple+Cherry → enter,down,down,enter,right,enter", () => {
    assert.equal(
      tokens(buildKeySequence([{ multiSelect: true, optionCount: 4, picks: [0, 2] }])),
      "enter,down,down,enter,right,enter",
    );
  });

  it("multi-select single pick Apple → enter,right,enter", () => {
    assert.equal(
      tokens(buildKeySequence([{ multiSelect: true, optionCount: 4, picks: [0] }])),
      "enter,right,enter",
    );
  });

  it("two single-select questions → enter,enter,enter", () => {
    assert.equal(
      tokens(
        buildKeySequence([
          { multiSelect: false, optionCount: 2, picks: [0] },
          { multiSelect: false, optionCount: 2, picks: [0] },
        ]),
      ),
      "enter,enter,enter",
    );
  });

  it("picks are toggled in ascending order regardless of input order", () => {
    assert.equal(
      tokens(buildKeySequence([{ multiSelect: true, optionCount: 4, picks: [2, 0] }])),
      "enter,down,down,enter,right,enter",
    );
  });
});

describe("AnswerDriver", () => {
  const makeDriver = (lastResult: () => number) => {
    const writes: string[] = [];
    let clock = 1000;
    const driver = new AnswerDriver({
      write: (s) => writes.push(s),
      lastToolResultTs: lastResult,
      now: () => clock++,
      setTimer: ((cb: () => void) => { cb(); return 0; }) as typeof setTimeout,
      timeouts: { settleMs: 0, keyGapMs: 0, verifyMs: 50 },
    });
    return { driver, writes };
  };

  it("feed() flips menuOpen on the menu footer, close() clears it", () => {
    const { driver } = makeDriver(() => 0);
    assert.equal(driver.menuOpen, false);
    driver.feed("some output ... Enter to select · ↑/↓ to navigate · Esc to cancel");
    assert.equal(driver.menuOpen, true);
    driver.close();
    assert.equal(driver.menuOpen, false);
  });

  it("answer() writes the verified key bytes and confirms via a fresh tool_result", async () => {
    const { driver, writes } = makeDriver(() => Number.POSITIVE_INFINITY);
    const outcome = await driver.answer([{ multiSelect: true, optionCount: 4, picks: [0, 2] }]);
    assert.equal(outcome, "answered");
    assert.deepEqual(writes, ["\r", "\x1b[B", "\x1b[B", "\r", "\x1b[C", "\r"]);
  });

  it("answer() reports unverified when no tool_result lands", async () => {
    const { driver } = makeDriver(() => 0);
    const outcome = await driver.answer([{ multiSelect: false, optionCount: 3, picks: [0] }]);
    assert.equal(outcome, "unverified");
  });
});
