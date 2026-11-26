import { describe, it, expect } from "vitest";
import { FAILURES, stateLine, fixFor, fixLabel, setupStep } from "./words.js";

describe("the capability words", () => {
  it("say a source that is gone, and a call whose subject is gone", () => {
    expect(stateLine({ state: "needs_setup", stateCode: "source_gone" })).toBe("What a routine reads through it is gone, such as a deleted repository.");
    expect(FAILURES.gone).toBe("What it names is not there any more.");
  });

  it("say what to do with a send the service refused as written, the one kind the item's summary leaves vague", () => {
    expect(FAILURES.validation).toBe("The service did not take it as written. Edit it and try again.");
  });
});

describe("the fix a capability offers", () => {
  it("never offers what its state rules out", () => {
    const github = { id: "github", name: "GitHub", state: "needs_setup", stateCode: "client_id_missing" };
    expect(fixFor(github)).toBe("open-setup");
    expect(fixLabel(github, fixFor(github))).toBe("Set it up");
    expect(fixFor(github, "page")).toBe("check");
    expect(setupStep(github)).toBe("Set github.clientId in Eos's config file, then check again.");
    const linear = { id: "linear", state: "needs_sign_in", stateCode: "http_401", secrets: [{ name: "api_key", label: "Linear API key", set: true }] };
    expect(fixLabel(linear, fixFor(linear))).toBe("Sign in again");
    expect(fixLabel(linear, fixFor(linear, "page"))).toBe("Replace Linear API key");
    expect(fixFor({ id: "github", state: "needs_sign_in" })).toBe("sign-in");
    expect(fixFor({ id: "x", state: "disabled" })).toBe("enable");
    expect(fixFor({ id: "x", state: "broken" })).toBe("check");
    expect(fixFor({ id: "x", state: "ready" })).toBe(null);
  });
});
