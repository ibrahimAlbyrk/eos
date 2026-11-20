import { describe, it, expect } from "vitest";
import { confirmModelSummary, answerModelSummary } from "./modelSummaryConfirm.js";
import { modelSummaryMessage } from "../views/agents/center/ModelSummaryDialog.jsx";

describe("confirmModelSummary", () => {
  it("waits for the user's answer", async () => {
    const yes = confirmModelSummary({ id: "w-1" }, "sonnet");
    answerModelSummary(true);
    await expect(yes).resolves.toBe(true);
    const no = confirmModelSummary({ id: "w-1" }, "sonnet");
    answerModelSummary(false);
    await expect(no).resolves.toBe(false);
  });

  it("a newer question turns the older one down", async () => {
    const first = confirmModelSummary({ id: "w-1" }, "sonnet");
    const second = confirmModelSummary({ id: "w-1" }, "opus");
    await expect(first).resolves.toBe(false);
    answerModelSummary(true);
    await expect(second).resolves.toBe(true);
  });
});

describe("modelSummaryMessage", () => {
  it("names the sizes when the context meter knows them", () => {
    expect(modelSummaryMessage({ worker: { last_context_tokens: 315_000 }, model: "small-model" })).toBe(
      "This conversation (~315.0k tokens) doesn't fit small-model's 200.0k context. "
        + "To switch, it is summarized first with the current model, and small-model continues from the summary.",
    );
  });

  it("says it plainly when the meter thinks it fits", () => {
    expect(modelSummaryMessage({ worker: { last_context_tokens: 50_000 }, model: "sonnet" })).toBe(
      "This conversation doesn't fit Sonnet 5.5's context. "
        + "To switch, it is summarized first with the current model, and Sonnet 5.5 continues from the summary.",
    );
  });
});
