import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IdleHooks } from "../IdleHooks.ts";

describe("IdleHooks", () => {
  it("runs hooks in order; one that takes the worker stops the rest", () => {
    const ran: string[] = [];
    const hooks = new IdleHooks();
    hooks.add({ id: "b", order: 20, run: () => { ran.push("b"); } });
    hooks.add({ id: "a", order: 10, run: (id) => { ran.push(`a:${id}`); return id === "busy"; } });
    hooks.add({ id: "c", order: 30, run: () => { ran.push("c"); } });
    hooks.run("w1");
    hooks.run("busy");
    assert.deepEqual(ran, ["a:w1", "b", "c", "a:busy"]);
  });

  it("a removed hook no longer runs", () => {
    const ran: string[] = [];
    const hooks = new IdleHooks();
    const off = hooks.add({ id: "a", order: 1, run: () => { ran.push("a"); } });
    off();
    hooks.run("w1");
    assert.deepEqual(ran, []);
  });
});
