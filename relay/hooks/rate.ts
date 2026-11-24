// How often an outside service may post to one hook (07 §9): 120 a minute. In memory: a relay
// restart forgives the window.
export const HOOK_POSTS_PER_MINUTE = 120;

const MINUTE_MS = 60 * 1000;

export class HookRate {
  private readonly now: () => number;
  private readonly recent = new Map<string, number[]>(); // hook -> post times of the last minute

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  take(hook: string): boolean {
    const nowMs = this.now();
    const times = (this.recent.get(hook) ?? []).filter((t) => nowMs - t < MINUTE_MS);
    const allowed = times.length < HOOK_POSTS_PER_MINUTE;
    if (allowed) times.push(nowMs);
    if (times.length > 0) this.recent.set(hook, times);
    else this.recent.delete(hook);
    return allowed;
  }
}
