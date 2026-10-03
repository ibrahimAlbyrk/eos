import { describe, it, expect, beforeEach } from "vitest";
import { recordVisit, updateMeta, suggestions, getSnapshot, _reset } from "./browserHistoryStore.js";

const DAY = 24 * 60 * 60 * 1000;

describe("browserHistoryStore", () => {
  beforeEach(() => {
    globalThis.localStorage?.clear?.();
    _reset();
  });

  it("ranks by visits decayed by age and ignores non-web URLs", () => {
    const now = 100 * DAY;
    recordVisit({ url: "https://old.example/", title: "Old" }, now - 30 * DAY);
    recordVisit({ url: "https://old.example/", title: "Old" }, now - 30 * DAY);
    recordVisit({ url: "https://new.example/#x", title: "New" }, now);
    recordVisit({ url: "about:blank" }, now);
    recordVisit({ url: "chrome://settings" }, now);
    const s = suggestions(4, now);
    expect(s.map((e) => e.host)).toEqual(["new.example", "old.example"]);
    expect(s[0].url).toBe("https://new.example");
  });

  it("flags local dev servers and fills in a later title", () => {
    recordVisit({ url: "http://localhost:5173/", title: "" }, 1);
    updateMeta({ url: "http://localhost:5173/", title: "Vite App" });
    const [e] = suggestions(1, 1);
    expect(e.local).toBe(true);
    expect(e.title).toBe("Vite App");
  });

  it("returns the same snapshot while unchanged, even with no history", () => {
    expect(getSnapshot()).toBe(getSnapshot());
    recordVisit({ url: "https://a.example/" });
    expect(getSnapshot()).toBe(getSnapshot());
  });
});
