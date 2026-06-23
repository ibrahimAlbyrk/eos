// Pure use-case: assemble the device date+time DTO from the Clock instant and
// the TimeZoneProvider's instant-parameterized offset. No ambient reads, no
// Intl — only plain Date arithmetic on the injected epoch — so it is fully
// deterministic under a fake clock + fake provider. Mirrors the contracts
// CurrentDateTimeResponseSchema (the single source of truth for the shape).

import type { Clock } from "../ports/Clock.ts";
import type { TimeZoneProvider } from "../ports/TimeZoneProvider.ts";

export interface CurrentDateTime {
  epochMs: number;
  iso: string;
  utc: string;
  timeZone: string;
  utcOffsetMinutes: number;
  formatted: string;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

// "+03:00" / "-05:30" / "+00:00" — the offset rendered from minutes east of UTC.
function offsetLabel(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function currentDateTime(clock: Clock, tz: TimeZoneProvider): CurrentDateTime {
  const epochMs = clock.now();
  const offsetMinutes = tz.offsetMinutesAt(epochMs);
  const offset = offsetLabel(offsetMinutes);

  // Shift the instant by the offset, then read its UTC fields — that yields the
  // local wall-clock components without any timezone-aware formatter.
  const local = new Date(epochMs + offsetMinutes * 60_000);
  const date = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  const timeZone = tz.name();

  return {
    epochMs,
    iso: `${date}T${time}.${pad(local.getUTCMilliseconds(), 3)}${offset}`,
    utc: new Date(epochMs).toISOString(),
    timeZone,
    utcOffsetMinutes: offsetMinutes,
    formatted: `${date} ${time} UTC${offset} (${timeZone})`,
  };
}
