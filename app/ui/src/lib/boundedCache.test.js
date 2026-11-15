import { describe, it, expect } from "vitest";
import { boundedCache } from "./boundedCache.js";

const sizeOf = (k, v) => k.length + v.length;

describe("boundedCache", () => {
  it("forgets the oldest entries past the entry cap", () => {
    const c = boundedCache({ maxEntries: 2, maxChars: Infinity, sizeOf });
    c.set("a", "1");
    c.set("b", "2");
    c.set("c", "3");
    expect(c.has("a")).toBe(false);
    expect(c.get("b")).toBe("2");
    expect(c.get("c")).toBe("3");
    expect(c.size).toBe(2);
  });

  it("forgets the oldest entries past the character budget", () => {
    const c = boundedCache({ maxEntries: 100, maxChars: 10, sizeOf });
    c.set("a", "1234");  // 5
    c.set("b", "1234");  // 10
    expect(c.size).toBe(2);
    c.set("c", "12");    // 13 → "a" goes
    expect(c.has("a")).toBe(false);
    expect(c.chars).toBe(8);
  });

  it("keeps the newest entry even when it alone is over budget", () => {
    const c = boundedCache({ maxEntries: 100, maxChars: 4, sizeOf });
    c.set("a", "1");
    c.set("big", "123456789");
    expect(c.has("a")).toBe(false);
    expect(c.get("big")).toBe("123456789");
  });

  it("re-setting a key counts it once", () => {
    const c = boundedCache({ maxEntries: 100, maxChars: 100, sizeOf });
    c.set("a", "12");
    c.set("a", "1234");
    expect(c.size).toBe(1);
    expect(c.chars).toBe(5);
  });
});
