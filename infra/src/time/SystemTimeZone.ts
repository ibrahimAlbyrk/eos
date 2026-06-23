import type { TimeZoneProvider } from "../../../core/src/ports/TimeZoneProvider.ts";

// The daemon is a long-lived process on the user's Mac, so these host reads ARE
// the device timezone: Intl resolves the IANA zone name, and getTimezoneOffset
// (negated — it returns minutes WEST of UTC) gives the DST-correct offset at the
// passed instant. Sits beside SystemClock.ts as the second time-port adapter.
export const systemTimeZone: TimeZoneProvider = {
  name: (): string => Intl.DateTimeFormat().resolvedOptions().timeZone,
  offsetMinutesAt: (epochMs: number): number => -new Date(epochMs).getTimezoneOffset(),
};
