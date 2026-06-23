import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { currentDateTime } from "../use-cases/CurrentDateTime.ts";
import type { Clock } from "../ports/Clock.ts";
import type { TimeZoneProvider } from "../ports/TimeZoneProvider.ts";

const fixedClock = (ms: number): Clock => ({ now: () => ms });
const fixedZone = (name: string, offset: number): TimeZoneProvider => ({
  name: () => name,
  offsetMinutesAt: () => offset,
});

describe("currentDateTime", () => {
  it("assembles the exact DTO from the clock instant + zone offset", () => {
    // 2026-06-24T11:32:05.123Z == 14:32:05 in +03:00.
    const epochMs = Date.parse("2026-06-24T11:32:05.123Z");
    const dto = currentDateTime(fixedClock(epochMs), fixedZone("Europe/Istanbul", 180));
    assert.deepEqual(dto, {
      epochMs,
      iso: "2026-06-24T14:32:05.123+03:00",
      utc: "2026-06-24T11:32:05.123Z",
      timeZone: "Europe/Istanbul",
      utcOffsetMinutes: 180,
      formatted: "2026-06-24 14:32:05 UTC+03:00 (Europe/Istanbul)",
    });
    assert.ok(dto.iso.endsWith("+03:00"));
    assert.ok(dto.utc.endsWith("Z"));
  });

  it("renders a negative offset and zero-pads sub-hour offsets", () => {
    const epochMs = Date.parse("2026-01-15T00:00:00.000Z");
    const dto = currentDateTime(fixedClock(epochMs), fixedZone("America/St_Johns", -210));
    // -210 min == -03:30, so local wall clock is the prior day 20:30.
    assert.equal(dto.iso, "2026-01-14T20:30:00.000-03:30");
    assert.equal(dto.utcOffsetMinutes, -210);
    assert.equal(dto.formatted, "2026-01-14 20:30:00 UTC-03:30 (America/St_Johns)");
  });

  // DST: ONE provider instance returning a different offset per instant proves
  // the offset is parameterized by the instant, not a constant.
  it("reflects a DST shift — offset differs by instant for the same zone", () => {
    const dst = Date.parse("2026-07-01T12:00:00.000Z"); // British Summer Time
    const std = Date.parse("2026-01-01T12:00:00.000Z"); // Greenwich Mean Time
    const london: TimeZoneProvider = {
      name: () => "Europe/London",
      offsetMinutesAt: (ms) => (ms >= Date.parse("2026-03-29T01:00:00.000Z") && ms < Date.parse("2026-10-25T01:00:00.000Z") ? 60 : 0),
    };

    const summer = currentDateTime(fixedClock(dst), london);
    assert.equal(summer.utcOffsetMinutes, 60);
    assert.equal(summer.iso, "2026-07-01T13:00:00.000+01:00");

    const winter = currentDateTime(fixedClock(std), london);
    assert.equal(winter.utcOffsetMinutes, 0);
    assert.equal(winter.iso, "2026-01-01T12:00:00.000+00:00");
  });
});
