import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DreamConsolidateOutputSchema, DreamRecallOutputSchema } from "../dream.ts";

describe("dream contracts", () => {
  it("recall output: observations with event-id evidence", () => {
    const ok = DreamRecallOutputSchema.safeParse({
      observations: [{ statement: "Wants a deep think-through first.", kind: "preference", scope: "global", evidence: [12, 40] }],
    });
    assert.ok(ok.success);
    assert.ok(!DreamRecallOutputSchema.safeParse({ observations: [{ statement: "", kind: "preference", scope: "global", evidence: [] }] }).success);
  });

  it("consolidate output: defaults fill, unknown kinds fail", () => {
    const r = DreamConsolidateOutputSchema.parse({
      proposals: [{ kind: "new", text: "Prefers pnpm.", category: "stack", scope: "global", confidence: 3 }],
    });
    assert.equal(r.narrative, "");
    assert.deepEqual(r.proposals[0]!.targets, []);
    assert.equal(r.proposals[0]!.project, null);
    assert.deepEqual(r.dropped, {});
    assert.ok(!DreamConsolidateOutputSchema.safeParse({ proposals: [{ kind: "rename", text: "x", category: "stack", scope: "global", confidence: 3 }] }).success);
    assert.ok(!DreamConsolidateOutputSchema.safeParse({ proposals: [{ kind: "new", text: "x", category: "stack", scope: "global", confidence: 5 }] }).success);
  });
});
