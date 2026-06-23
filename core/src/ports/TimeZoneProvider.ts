// TimeZoneProvider port — the device's timezone, which Clock.now() cannot
// carry (an epoch is only a UTC instant). offsetMinutesAt is parameterized by
// instant so the offset is DST-correct (the same zone returns different offsets
// across a DST boundary). Kept separate from Clock (SRP): Clock is reused for
// TTL/heartbeats and must not change. Infra implements it with Intl + Date.

export interface TimeZoneProvider {
  name(): string;
  offsetMinutesAt(epochMs: number): number;
}
