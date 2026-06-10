import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PendingMessageRegistry } from "../message-registry.ts";

const user = (displayText?: string) =>
  ({ as: "user_message" as const, ...(displayText ? { displayText } : {}) });

describe("PendingMessageRegistry — consumeMatching", () => {
  it("pairs a transcript user entry with its pending record", () => {
    const reg = new PendingMessageRegistry();
    reg.register("fix the failing test in delivery.ts", user());
    const hits = reg.consumeMatching("fix the failing test in delivery.ts");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].text, "fix the failing test in delivery.ts");
    // Consumed — a second sighting of the same text matches nothing.
    assert.deepEqual(reg.consumeMatching("fix the failing test in delivery.ts"), []);
  });

  it("tolerates composer wrapping (whitespace differences)", () => {
    const reg = new PendingMessageRegistry();
    reg.register("a long message that the composer wraps across lines", user());
    const hits = reg.consumeMatching("a long message that\nthe composer wraps  across lines");
    assert.equal(hits.length, 1);
  });

  it("matches a slash command split across command tags", () => {
    const reg = new PendingMessageRegistry();
    reg.register("/clear", user());
    const hits = reg.consumeMatching("<command-name>/clear</command-name><command-args></command-args>");
    assert.equal(hits.length, 1);
  });

  it("does not consume non-matching entries", () => {
    const reg = new PendingMessageRegistry();
    reg.register("first pending message kept intact", user());
    assert.deepEqual(reg.consumeMatching("a completely different transcript entry"), []);
    assert.equal(reg.drainAll().length, 1);
  });

  it("consumes every entry merged into a single submission, in order", () => {
    const reg = new PendingMessageRegistry();
    reg.register("steer one: stop touching the tests", user());
    reg.register("steer two: also update the docs", user());
    const hits = reg.consumeMatching(
      "steer one: stop touching the tests\nsteer two: also update the docs",
    );
    assert.deepEqual(hits.map((h) => h.text), [
      "steer one: stop touching the tests",
      "steer two: also update the docs",
    ]);
  });

  it("keeps the record meta (displayText, orchestrator fields)", () => {
    const reg = new PendingMessageRegistry();
    reg.register("full action prompt body here", user("/commit"));
    reg.register("directive text from the parent", { as: "orchestrator_message", fromParent: "o-1", parentName: "hub" });
    const [a] = reg.consumeMatching("full action prompt body here");
    assert.deepEqual(a.record, { as: "user_message", displayText: "/commit" });
    const [b] = reg.consumeMatching("directive text from the parent");
    assert.deepEqual(b.record, { as: "orchestrator_message", fromParent: "o-1", parentName: "hub" });
  });
});

describe("PendingMessageRegistry — resolution paths", () => {
  it("consumeByText removes exactly the delivery's entry", () => {
    const reg = new PendingMessageRegistry();
    reg.register("same text", user());
    reg.register("same text", user("second"));
    const hit = reg.consumeByText("same text");
    assert.equal(hit?.record.as, "user_message");
    assert.equal(reg.drainAll().length, 1);
  });

  it("consumeByText returns null for unregistered text (boot prompt path)", () => {
    const reg = new PendingMessageRegistry();
    assert.equal(reg.consumeByText("boot prompt never registered"), null);
  });

  it("drainAll empties the registry in registration order", () => {
    const reg = new PendingMessageRegistry();
    reg.register("one", user());
    reg.register("two", user());
    assert.deepEqual(reg.drainAll().map((e) => e.text), ["one", "two"]);
    assert.deepEqual(reg.drainAll(), []);
  });

  it("evicts oldest entries past the cap and returns them for emission", () => {
    const reg = new PendingMessageRegistry();
    for (let i = 0; i < 50; i++) assert.deepEqual(reg.register(`msg ${i} padding text`, user()), []);
    const evicted = reg.register("msg 50 padding text", user());
    assert.deepEqual(evicted.map((e) => e.text), ["msg 0 padding text"]);
  });
});
