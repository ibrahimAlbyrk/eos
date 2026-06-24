import { describe, it, expect } from "vitest";
import { applyRecalls } from "./messageParser.js";

const ev = (id, type, payload) => ({ id, type, payload: JSON.stringify(payload) });

describe("applyRecalls", () => {
  it("hides the user_message matched by recalledRowId and drops the marker", () => {
    const events = [
      ev(1, "user_message", { text: "older", clientMsgIds: ["c0"] }),
      ev(5, "user_message", { text: "recalled", clientMsgIds: ["c1"] }),
      ev(6, "message_recalled", { text: "recalled", clientMsgId: "c1", recalledRowId: 5 }),
    ];
    const out = applyRecalls(events);
    expect(out.map((e) => e.id)).toEqual([1]); // the older bubble survives; recalled one + marker gone
  });

  it("falls back to clientMsgId when no recalledRowId is given (keyless rowId path)", () => {
    const events = [
      ev(5, "user_message", { text: "recalled", clientMsgIds: ["c1"] }),
      ev(6, "message_recalled", { text: "recalled", clientMsgId: "c1" }),
    ];
    expect(applyRecalls(events)).toEqual([]);
  });

  it("is a no-op (same reference) when there is no message_recalled marker", () => {
    const events = [ev(1, "user_message", { text: "hi", clientMsgIds: ["c1"] })];
    expect(applyRecalls(events)).toBe(events);
  });

  it("leaves unrelated user_messages and other event rows intact", () => {
    const events = [
      ev(1, "user_message", { text: "keep", clientMsgIds: ["cA"] }),
      ev(2, "agent_event", { type: "message" }),
      ev(3, "user_message", { text: "gone", clientMsgIds: ["cB"] }),
      ev(4, "message_recalled", { text: "gone", clientMsgId: "cB", recalledRowId: 3 }),
    ];
    expect(applyRecalls(events).map((e) => e.id)).toEqual([1, 2]);
  });
});
