import { describe, it, expect } from "vitest";
import { relativeUntil, toDatetimeLocal, nextMorning } from "./scheduleTime.js";

describe("relativeUntil", () => {
  it("reads 'şimdi' for a past or present fireAt", () => {
    expect(relativeUntil(1000, 1000)).toBe("şimdi");
    expect(relativeUntil(500, 1000)).toBe("şimdi");
  });

  it("rounds up to at least 1 minute for an imminent prompt", () => {
    expect(relativeUntil(30_000, 0)).toBe("~1 dk");
  });

  it("shows minutes under an hour", () => {
    expect(relativeUntil(27 * 60_000, 0)).toBe("~27 dk");
  });

  it("shows hours under a day", () => {
    expect(relativeUntil(3 * 3_600_000, 0)).toBe("~3 sa");
  });

  it("shows days beyond a day", () => {
    expect(relativeUntil(2 * 86_400_000, 0)).toBe("~2 g");
  });
});

describe("toDatetimeLocal + nextMorning", () => {
  it("nextMorning lands on the next day at 09:00 local", () => {
    const now = new Date(2026, 6, 7, 15, 30).getTime(); // 2026-07-07 15:30 local
    const at = nextMorning(now);
    const d = new Date(at);
    expect(d.getDate()).toBe(8);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
  });

  it("toDatetimeLocal formats without seconds or timezone", () => {
    const ms = new Date(2026, 6, 7, 9, 5).getTime();
    expect(toDatetimeLocal(ms)).toBe("2026-07-07T09:05");
  });
});
