// Clock port — tested code calls `clock.now()` instead of `Date.now()` so
// tests can inject a fake clock for time-dependent logic (TTL, heartbeats,
// budget elapsed checks).

export interface Clock {
  now(): number;
}
