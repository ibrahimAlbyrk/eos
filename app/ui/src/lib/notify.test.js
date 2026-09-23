import { describe, it, expect, vi } from "vitest";
import { notify } from "./notify.js";

// Toasts were removed from the app (charcoal-aurora redesign). notify is now a
// no-op facade kept so the many existing call sites don't crash without a
// visible surface. These guard that stable contract.
describe("notify facade (no-op)", () => {
  it("exposes the stable verb set", () => {
    for (const k of ["info", "warning", "error", "dismiss", "clear"]) {
      expect(typeof notify[k]).toBe("function");
    }
  });

  it("verbs are safe to call and never throw", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => {
      const id = notify.error("Push failed", { title: "Git", duration: 6000 });
      notify.info("hi");
      notify.warning("careful");
      notify.dismiss(id);
      notify.clear();
    }).not.toThrow();
    vi.restoreAllMocks();
  });
});
