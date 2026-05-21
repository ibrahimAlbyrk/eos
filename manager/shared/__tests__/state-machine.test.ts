import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canTransition, ALLOWED_TRANSITIONS, type WorkerState } from "../state-machine.ts";

describe("canTransition", () => {
  it("permits SPAWNING → anything", () => {
    const targets: WorkerState[] = ["WORKING", "IDLE", "ENDING", "DONE", "KILLING"];
    for (const t of targets) assert.equal(canTransition("SPAWNING", t), true, `SPAWNING → ${t}`);
  });

  it("permits WORKING → IDLE, ENDING, DONE, KILLING", () => {
    assert.equal(canTransition("WORKING", "IDLE"), true);
    assert.equal(canTransition("WORKING", "ENDING"), true);
    assert.equal(canTransition("WORKING", "DONE"), true);
    assert.equal(canTransition("WORKING", "KILLING"), true);
  });

  it("permits IDLE → WORKING (turn resume)", () => {
    assert.equal(canTransition("IDLE", "WORKING"), true);
  });

  it("forbids WORKING → SPAWNING (no backward to startup)", () => {
    assert.equal(canTransition("WORKING", "SPAWNING"), false);
  });

  it("forbids DONE → anything (terminal)", () => {
    const targets: WorkerState[] = ["SPAWNING", "WORKING", "IDLE", "ENDING", "KILLING"];
    for (const t of targets) assert.equal(canTransition("DONE", t), false, `DONE → ${t}`);
  });

  it("permits KILLING → DONE only", () => {
    assert.equal(canTransition("KILLING", "DONE"), true);
    assert.equal(canTransition("KILLING", "WORKING"), false);
    assert.equal(canTransition("KILLING", "IDLE"), false);
  });

  it("permits ENDING → DONE / KILLING only", () => {
    assert.equal(canTransition("ENDING", "DONE"), true);
    assert.equal(canTransition("ENDING", "KILLING"), true);
    assert.equal(canTransition("ENDING", "WORKING"), false);
    assert.equal(canTransition("ENDING", "IDLE"), false);
  });

  it("treats self-transitions as allowed (caller short-circuits)", () => {
    const all: WorkerState[] = ["SPAWNING", "WORKING", "IDLE", "ENDING", "DONE", "KILLING"];
    for (const s of all) assert.equal(canTransition(s, s), true, `${s} → ${s}`);
  });
});

describe("ALLOWED_TRANSITIONS shape", () => {
  it("DONE has no outgoing transitions (terminal)", () => {
    assert.equal(ALLOWED_TRANSITIONS.DONE.length, 0);
  });
  it("KILLING only goes to DONE", () => {
    assert.deepEqual([...ALLOWED_TRANSITIONS.KILLING], ["DONE"]);
  });
  it("every state has an entry (exhaustive)", () => {
    const states: WorkerState[] = ["SPAWNING", "WORKING", "IDLE", "ENDING", "DONE", "KILLING"];
    for (const s of states) assert.ok(s in ALLOWED_TRANSITIONS, `missing entry for ${s}`);
  });
});
