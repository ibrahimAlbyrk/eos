import { describe, it, expect } from "vitest";
import { FAILURES, stateLine } from "./words.js";

describe("the capability words", () => {
  it("say a source that is gone, and a call whose subject is gone", () => {
    expect(stateLine({ state: "needs_setup", stateCode: "source_gone" })).toBe("What a routine reads through it is gone, such as a deleted repository.");
    expect(FAILURES.gone).toBe("What it names is not there any more.");
  });

  it("say what to do with a send the service refused as written, the one kind the item's summary leaves vague", () => {
    expect(FAILURES.validation).toBe("The service did not take it as written. Edit it and try again.");
  });
});
