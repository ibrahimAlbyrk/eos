// How often a room may push (07 G21): a stuck or hostile Mac cannot flood its phones or the
// operator's APNs key. In memory: a relay restart forgives the window.
export const PUSHES_PER_MINUTE = 30;
export const PUSHES_PER_HOUR = 300;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export class PushRate {
  private readonly now: () => number;
  private readonly recent = new Map<string, number[]>(); // room -> push times of the last hour, oldest first

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  // Counts the push when it is allowed; a refused one does not count.
  take(room: string): boolean {
    const nowMs = this.now();
    const times = (this.recent.get(room) ?? []).filter((t) => nowMs - t < HOUR_MS);
    const lastMinute = times.filter((t) => nowMs - t < MINUTE_MS).length;
    const allowed = times.length < PUSHES_PER_HOUR && lastMinute < PUSHES_PER_MINUTE;
    if (allowed) times.push(nowMs);
    if (times.length > 0) this.recent.set(room, times);
    else this.recent.delete(room);
    return allowed;
  }
}
