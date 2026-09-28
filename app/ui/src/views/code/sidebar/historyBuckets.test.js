import { describe, it, expect } from "vitest";
import { historyBuckets, ranLabel } from "./historyBuckets.js";

const now = new Date(2026, 8, 28, 15, 0).getTime(); // Mon Sep 28 2026, 15:00 local
const at = (y, m, d, h = 12, min = 0) => new Date(y, m, d, h, min).getTime();
const entry = (id, closedAt, extra = {}) => ({ id, kind: "claude", cwd: `/p/${id}`, title: id, closedAt, ...extra });

describe("historyBuckets", () => {
  it("groups by the day a session closed, leaving out empty buckets", () => {
    const b = historyBuckets([
      entry("a", at(2026, 8, 28, 14, 32)),
      entry("b", at(2026, 8, 27, 23, 59)),
      entry("c", at(2026, 8, 22, 9)),
      entry("d", at(2026, 8, 21, 23)),
    ], now);
    expect(b.map((x) => [x.key, x.items.map((i) => i.entry.id)])).toEqual([
      ["today", ["a"]], ["yesterday", ["b"]], ["week", ["c"]], ["older", ["d"]],
    ]);
    expect(historyBuckets([entry("a", at(2026, 8, 28, 1))], now).map((x) => x.key)).toEqual(["today"]);
  });

  it("labels recent ones by clock time, the week by weekday, older by date", () => {
    const [today, week, older, lastYear] = historyBuckets([
      entry("a", at(2026, 8, 28, 9, 5)),
      entry("c", at(2026, 8, 24)),
      entry("d", at(2026, 7, 3)),
      entry("e", at(2025, 11, 30)),
    ], now).flatMap((x) => x.items.map((i) => i.time));
    expect([today, week, older, lastYear]).toEqual(["09:05", "Thu", "Aug 3", "Dec 2025"]);
  });

  it("carries the folder name and how long it ran, when known", () => {
    const [item] = historyBuckets([entry("a", now, { cwd: "/Users/me/eos/", startedAt: now - 70 * 60000 })], now)[0].items;
    expect(item).toMatchObject({ folder: "eos", ran: "1 h 10 min" });
    expect(historyBuckets([entry("b", now)], now)[0].items[0].ran).toBeNull();
  });

  it("a query keeps entries whose title or folder matches, case-insensitively", () => {
    const list = [
      entry("a", now, { title: "Fix PTY resize", cwd: "/x/eos" }),
      entry("b", now, { title: "zsh", cwd: "/x/relay" }),
      entry("c", now, { title: null, cwd: "/x/dotfiles" }),
    ];
    const ids = (q) => historyBuckets(list, now, q).flatMap((x) => x.items.map((i) => i.entry.id));
    expect(ids("pty")).toEqual(["a"]);
    expect(ids("RELAY")).toEqual(["b"]);
    expect(ids("dot")).toEqual(["c"]);
    expect(ids("nothing")).toEqual([]);
  });
});

describe("ranLabel", () => {
  it("rounds down to minutes, hours past sixty", () => {
    expect(ranLabel(20_000)).toBe("<1 min");
    expect(ranLabel(42 * 60000 + 59_000)).toBe("42 min");
    expect(ranLabel(120 * 60000)).toBe("2 h");
    expect(ranLabel(-1)).toBeNull();
  });
});
