import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getPrefs, setPref, _resetSidebarPrefs } from "./sidebarPrefsStore.js";

function stubStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    _data: data,
  };
}

beforeEach(() => {
  _resetSidebarPrefs();
  globalThis.localStorage = stubStorage();
});
afterEach(() => {
  delete globalThis.localStorage;
});

describe("sidebarPrefsStore", () => {
  it("defaults to folder / recency / active", () => {
    expect(getPrefs()).toEqual({ groupBy: "folder", sortBy: "recency", status: "active" });
  });

  it("setPref updates and persists valid values", () => {
    setPref("groupBy", "date");
    setPref("sortBy", "alpha");
    setPref("status", "all");
    expect(getPrefs()).toEqual({ groupBy: "date", sortBy: "alpha", status: "all" });
    expect(JSON.parse(globalThis.localStorage.getItem("cm:sidebarPrefs"))).toEqual({
      groupBy: "date", sortBy: "alpha", status: "all",
    });
  });

  it("ignores invalid keys/values", () => {
    setPref("groupBy", "nonsense");
    setPref("bogus", "x");
    expect(getPrefs().groupBy).toBe("folder");
  });

  it("hydrates persisted prefs after a reload, dropping bad fields", () => {
    globalThis.localStorage.setItem("cm:sidebarPrefs", JSON.stringify({ groupBy: "custom", sortBy: "zzz", status: "archived" }));
    _resetSidebarPrefs();
    expect(getPrefs()).toEqual({ groupBy: "custom", sortBy: "recency", status: "archived" });
  });

  it("returns a stable snapshot reference between reads", () => {
    const a = getPrefs();
    const b = getPrefs();
    expect(a).toBe(b);
  });
});
