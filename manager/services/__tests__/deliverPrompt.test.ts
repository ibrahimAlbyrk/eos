import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deliverPrompt } from "../pty/deliverPrompt.ts";

type Snap = { rows: { id: number; type: string }[]; running: boolean };

function harness(first: Snap, later: Snap) {
  const sent: string[][] = [];
  let polls = 0;
  return {
    sent,
    deps: {
      send: async (steps: string[]) => { sent.push(steps); return true; },
      conversation: () => (polls++ === 0 ? first : later),
      sleep: async () => {},
    },
  };
}

const idle: Snap = { rows: [{ id: 3, type: "user_message" }], running: false };

describe("deliverPrompt", () => {
  it("is done once the prompt shows up in the transcript", async () => {
    const { sent, deps } = harness(idle, { rows: [...idle.rows, { id: 7, type: "user_message" }], running: true });
    assert.equal(await deliverPrompt(deps, "hi"), true);
    assert.deepEqual(sent, [["\x1b[200~hi\x1b[201~", "\r"]]);
  });

  it("presses Enter once more when an idle Claude never recorded it", async () => {
    const { sent, deps } = harness(idle, idle);
    assert.equal(await deliverPrompt(deps, "hi"), true);
    assert.deepEqual(sent, [["\x1b[200~hi\x1b[201~", "\r"], ["\r"]]);
  });

  it("does not wait on a prompt queued mid-turn", async () => {
    const { sent, deps } = harness({ ...idle, running: true }, idle);
    assert.equal(await deliverPrompt(deps, "hi"), true);
    assert.equal(sent.length, 1);
  });
});
