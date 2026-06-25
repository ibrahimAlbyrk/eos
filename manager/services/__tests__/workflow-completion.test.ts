import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderWorkflowCompletion } from "../workflow-completion.ts";

describe("renderWorkflowCompletion", () => {
  it("headers the runId + status and embeds the full output", () => {
    const body = renderWorkflowCompletion({ runId: "run-1", status: "passed", output: { a: 1, b: "x" } });
    assert.equal(body, '[workflow run-1] completed (status: passed):\n{"a":1,"b":"x"}');
  });

  it("carries the failed status in the header", () => {
    const body = renderWorkflowCompletion({ runId: "run-2", status: "failed", output: "raw text" });
    assert.equal(body, '[workflow run-2] completed (status: failed):\n"raw text"');
  });
});
