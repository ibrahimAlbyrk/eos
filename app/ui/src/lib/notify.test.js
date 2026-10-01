import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { notify } from "./notify.js";

// No in-app surface: errors/warnings go to macOS via the shell's eosNotify bridge,
// info stays silent. These guard that contract and the stable verb set.
describe("notify facade", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    delete globalThis.eosNotify;
    vi.restoreAllMocks();
  });

  it("exposes the stable verb set", () => {
    for (const k of ["info", "warning", "error", "dismiss", "clear"]) {
      expect(typeof notify[k]).toBe("function");
    }
  });

  it("verbs are safe to call without the desktop bridge", () => {
    expect(() => {
      const id = notify.error("Push failed", { title: "Git", duration: 6000 });
      notify.info("hi");
      notify.warning("careful");
      notify.dismiss(id);
      notify.clear();
    }).not.toThrow();
  });

  it("sends errors and warnings to macOS, with the caller's title or a default", () => {
    const show = vi.fn();
    globalThis.eosNotify = { show };
    notify.error("Push failed", { title: "Git" });
    notify.warning("Branch has conflicts");
    notify.error("Copy failed");
    expect(show.mock.calls.map((c) => c[0])).toEqual([
      { title: "Git", body: "Push failed" },
      { title: "Warning", body: "Branch has conflicts" },
      { title: "Error", body: "Copy failed" },
    ]);
  });

  it("keeps info out of Notification Center", () => {
    const show = vi.fn();
    globalThis.eosNotify = { show };
    notify.info("Path copied");
    expect(show).not.toHaveBeenCalled();
  });
});
