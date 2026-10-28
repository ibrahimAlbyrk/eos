import { describe, it, expect, vi, afterEach } from "vitest";
import { applyFeatures, getFeatures, hasFeature, normalizeFeatures, subscribe } from "./featuresStore.js";
import { visibleSections } from "../settings/registry.jsx";
import { machinesMeta } from "../views/machines/meta.jsx";

afterEach(() => applyFeatures(null));

describe("featuresStore", () => {
  it("treats a missing flag as on — only an explicit false turns a feature off", () => {
    expect(normalizeFeatures(undefined)).toEqual({ remote: true, posixShell: true });
    expect(normalizeFeatures({})).toEqual({ remote: true, posixShell: true });
    expect(normalizeFeatures({ remote: true })).toEqual({ remote: true, posixShell: true });
    expect(normalizeFeatures({ remote: false })).toEqual({ remote: false, posixShell: true });
    expect(normalizeFeatures({ posixShell: false })).toEqual({ remote: true, posixShell: false });
  });

  it("is all on before the daemon answers", () => {
    expect(getFeatures()).toEqual({ remote: true, posixShell: true });
    expect(hasFeature("remote")).toBe(true);
  });

  it("applies the daemon's answer and tells subscribers only on a change", () => {
    const cb = vi.fn();
    const off = subscribe(cb);
    applyFeatures({ remote: true });
    expect(cb).not.toHaveBeenCalled();
    applyFeatures({ remote: false });
    expect(hasFeature("remote")).toBe(false);
    expect(cb).toHaveBeenCalledTimes(1);
    off();
  });

  it("hides Remote access, Machines and the Machines view where remote is off", () => {
    const ids = () => visibleSections().map((s) => s.id);
    expect(ids()).toEqual(expect.arrayContaining(["remote", "machines", "sync"]));
    expect(machinesMeta.visible()).toBe(true);

    applyFeatures({ remote: false });
    expect(ids()).not.toContain("remote");
    expect(ids()).not.toContain("machines");
    expect(ids()).toContain("sync");
    expect(machinesMeta.visible()).toBe(false);
  });
});
