import { describe, it, expect } from "vitest";
import { filterOptimistic, OPTIMISTIC_TTL_MS } from "./optimisticReconcile.js";

const entry = (over = {}) => ({ id: "opt-1", text: "hello", agentText: "hello", ts: 1000, ...over });

describe("filterOptimistic", () => {
  it("drops by clientMsgId match", () => {
    const list = [entry({ clientMsgId: "c1" }), entry({ id: "opt-2", clientMsgId: "c2", text: "other", agentText: "other" })];
    const out = filterOptimistic(list, { ids: new Set(["c1"]), texts: new Set() });
    expect(out.map((m) => m.id)).toEqual(["opt-2"]);
  });

  it("keeps a keyed entry whose text matches but id does not — id wins only positively", () => {
    // Text matching still applies to keyed entries: a drain combines messages,
    // so the durable text may cover them even when ids are present.
    const out = filterOptimistic([entry({ clientMsgId: "c1" })], { ids: new Set(["zzz"]), texts: new Set(["hello"]) });
    expect(out).toEqual([]);
  });

  it("drops by either-way text prefix (attachment suffixes)", () => {
    const out = filterOptimistic(
      [entry({ text: "hello", agentText: "hello\n\n[attachment]" })],
      { ids: new Set(), texts: new Set(["hello"]) },
    );
    expect(out).toEqual([]);
  });

  it("drops on a delivery_failed recorded after the send only", () => {
    const failures = [{ text: "hello", ts: 2000 }];
    expect(filterOptimistic([entry({ ts: 1000 })], { ids: new Set(), texts: new Set(), failures })).toEqual([]);
    expect(filterOptimistic([entry({ ts: 3000 })], { ids: new Set(), texts: new Set(), failures })).toHaveLength(1);
  });

  it("expires entries past the TTL", () => {
    const now = 1000 + OPTIMISTIC_TTL_MS + 1;
    expect(filterOptimistic([entry()], { ids: new Set(), texts: new Set(), now })).toEqual([]);
    expect(filterOptimistic([entry()], { ids: new Set(), texts: new Set(), now: 2000 })).toHaveLength(1);
  });
});
