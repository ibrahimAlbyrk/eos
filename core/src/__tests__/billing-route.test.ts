import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveBillingRoute } from "../domain/billing-route.ts";

describe("resolveBillingRoute — the Accounts rule", () => {
  it("a sign-in always bills the subscription, even with an API key set", () => {
    assert.equal(resolveBillingRoute("signed_in", true), "subscription");
    assert.equal(resolveBillingRoute("signed_in", false), "subscription");
  });

  it("an expired sign-in blocks instead of falling back to the API key", () => {
    assert.equal(resolveBillingRoute("expired", true), "blocked");
    assert.equal(resolveBillingRoute("expired", false), "blocked");
  });

  it("signed out uses the API key when set, else nothing", () => {
    assert.equal(resolveBillingRoute("signed_out", true), "api_key");
    assert.equal(resolveBillingRoute("signed_out", false), "none");
  });
});
