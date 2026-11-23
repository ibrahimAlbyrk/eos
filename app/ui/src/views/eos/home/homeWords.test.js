import { describe, it, expect } from "vitest";
import {
  absenceWord, awayLines, BUCKETS, bucketTitle, handledLine, hello, horizonBuckets, horizonSummary, learnedLine, needLine, numberWord,
} from "./homeWords.js";

const at = (h, m = 0, day = 17) => new Date(2026, 10, day, h, m).getTime();

describe("Home's greeting words", () => {
  it("says morning, afternoon or evening, with the name when there is one", () => {
    expect(hello(5, "Ada")).toBe("Good morning, Ada.");
    expect(hello(11, "")).toBe("Good morning.");
    expect(hello(12, "Ada")).toBe("Good afternoon, Ada.");
    expect(hello(18, "Ada")).toBe("Good evening, Ada.");
    expect(hello(3, "Ada")).toBe("Good evening, Ada.");
  });

  it("writes numbers in words to ten", () => {
    expect([0, 1, 3, 10, 11, 31].map(numberWord)).toEqual(["zero", "one", "three", "ten", "11", "31"]);
  });

  it("counts overnight when the absence covered the night and it is still morning, else since the last visit", () => {
    expect(absenceWord(at(9, 12), at(23, 0, 16))).toBe("overnight");
    expect(absenceWord(at(9, 12), null)).toBe("overnight");
    expect(absenceWord(at(9, 12), at(8, 0))).toBe("since you were last here");
    expect(absenceWord(at(14, 0), at(23, 0, 16))).toBe("since you were last here");
    expect(absenceWord(at(4, 0), at(23, 0, 16))).toBe("since you were last here");
    expect(handledLine(31, at(9, 12), null)).toBe("Eos handled 31 things overnight.");
    expect(handledLine(1, at(15, 0), at(14, 0))).toBe("Eos handled one thing since you were last here.");
    expect(handledLine(0, at(9, 12), null)).toBe("Nothing new overnight.");
  });

  it("says how many need the user, and nothing at none", () => {
    expect(needLine(3)).toBe("Three need you.");
    expect(needLine(1)).toBe("One needs you.");
    expect(needLine(12)).toBe("12 need you.");
    expect(needLine(0)).toBeNull();
    expect(learnedLine(14)).toBe("Eos learned 14 things this week.");
    expect(learnedLine(0)).toBeNull();
  });
});

describe("the horizon", () => {
  const run = (at0, state, routineId = "rt-1", needsUser = false) => ({ id: `rn-${at0}`, routineId, state, needsUser, createdAt: at0, startedAt: at0 });

  it("puts runs in 15-minute buckets showing the most urgent state, and later slots as scheduled", () => {
    const now = at(9, 12);
    const runs = [
      run(at(8, 5), "done"), run(at(8, 10), "waiting_for_user", "rt-2", true), run(at(9, 0), "running"),
      run(at(6, 0), "done"), run(at(23, 0, 16), "done"),
    ];
    const buckets = horizonBuckets(runs, [{ routineId: "rt-1", at: at(11, 0) }, { routineId: "rt-1", at: at(8, 0) }], now, { "rt-2": "PR Review" });
    expect(buckets.map((b) => [b.index, b.state])).toEqual([[24, "done"], [32, "waiting"], [36, "now"], [44, "scheduled"]]);
    expect(bucketTitle(buckets[1])).toBe("08:10 PR Review, waiting for you");
    expect(BUCKETS).toBe(96);
  });

  it("never draws more than 96 buckets for a busy day", () => {
    const now = at(23, 59);
    const runs = Array.from({ length: 400 }, (_, i) => run(at(0) + i * 3 * 60 * 1000, "done"));
    expect(horizonBuckets(runs, [], now).length).toBeLessThanOrEqual(96);
  });

  it("sums the day for screen readers", () => {
    const now = at(9, 12);
    const runs = [run(at(8, 5), "done"), run(at(8, 10), "waiting_for_user", "rt-2", true), run(at(7, 0), "waiting_for_user", "rt-2", true), run(at(6), "done"), run(at(5), "done")];
    expect(horizonSummary(runs, [{ at: at(10) }, { at: at(12) }], now)).toBe("Today so far: five runs, two of them waiting for you. Two more are scheduled.");
    expect(horizonSummary([], [], now)).toBe("Nothing has run today.");
  });
});

describe("while you were away", () => {
  it("keeps one line per routine, its newest ended run since the visit, five at most, no trials", () => {
    const ended = (id, routineId, end, kind = "standing") => ({ id, routineId, kind, endedAt: end, state: "done" });
    const runs = [
      ended("a", "rt-1", at(3)), ended("b", "rt-1", at(4)), ended("c", "rt-2", at(2)), ended("t", "rt-3", at(5), "trial"),
      ended("old", "rt-4", at(20, 0, 16)), ...["rt-5", "rt-6", "rt-7", "rt-8"].map((r, i) => ended(r, r, at(1, i))),
    ];
    expect(awayLines(runs, at(0)).map((r) => r.id)).toEqual(["b", "c", "rt-8", "rt-7", "rt-6"]);
  });
});
