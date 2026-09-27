import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AnswerShapeError, answerSteps, isShellProcess, promptSteps, stepGapMs } from "../pty/claudeKeys.ts";

const single = (n = 3) => ({ multiSelect: false, optionCount: n });
const multi = (n = 3) => ({ multiSelect: true, optionCount: n });

describe("claudeKeys", () => {
  it("pastes a prompt, then submits with a lone Enter after a longer pause", () => {
    const steps = promptSteps("line one\nline two");
    assert.deepEqual(steps, ["\x1b[200~line one\nline two\x1b[201~", "\r"]);
    assert.ok(stepGapMs(steps[0]) > stepGapMs(steps[1]));
  });

  it("answers one single-select question with its digit alone (no review step)", () => {
    assert.deepEqual(answerSteps([single()], [{ options: [1] }]), ["2"]);
  });

  it("types free text into 'Type something' — the digit after the last option", () => {
    assert.deepEqual(answerSteps([single(3)], [{ text: "Purple\nhaze " }]), ["4", "Purple haze", "\r"]);
  });

  it("toggles multi-select digits, moves on with →, and submits the review", () => {
    assert.deepEqual(answerSteps([multi()], [{ options: [0, 2, 0] }]), ["1", "3", "\x1b[C", "\r"]);
  });

  it("walks several questions then submits the review", () => {
    assert.deepEqual(
      answerSteps([single(), multi()], [{ text: "Teal" }, { options: [1] }]),
      ["4", "Teal", "\r", "2", "\x1b[C", "\r"],
    );
    assert.deepEqual(answerSteps([single(), single()], [{ options: [2] }, { options: [0] }]), ["3", "1", "\r"]);
  });

  it("rejects answers the dialog can't take", () => {
    const bad: Array<[Parameters<typeof answerSteps>[0], Parameters<typeof answerSteps>[1]]> = [
      [[single()], []],
      [[single()], [{ options: [0, 1] }]],
      [[single(2)], [{ options: [2] }]],
      [[multi()], [{ text: "x" }]],
      [[single()], [{ text: "\n" }]],
      [[single(9)], [{ options: [0] }]],
    ];
    for (const [q, a] of bad) assert.throws(() => answerSteps(q, a), AnswerShapeError);
  });

  it("recognizes shells, including login shells", () => {
    assert.ok(isShellProcess("zsh"));
    assert.ok(isShellProcess("-bash"));
    assert.ok(isShellProcess("/bin/zsh")); // how a fresh pane reports before its command starts
    assert.ok(!isShellProcess("2.1.283")); // Claude Code's process title
    assert.ok(!isShellProcess("claude"));
  });
});
