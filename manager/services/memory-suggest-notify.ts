// Memory-suggestion notification. Agents may suggest several memories in a burst;
// the user gets ONE banner a little later ("Agents noticed 3 things") counting
// whatever is still waiting, instead of a banner per suggestion. Clicking it opens
// the Memory view (`route`).

import type { UserMemoryChangeEvent } from "../../contracts/src/profile.ts";
import type { NotificationFire } from "./permission-ask-notify.ts";

export const MEMORY_NOTIFY_DELAY_MS = 30_000;

export interface MemorySuggestNotifyDeps {
  // Waiting agent suggestions (dream proposals excluded).
  pendingCount(): number;
  fire(notification: NotificationFire): void;
  now(): number;
  schedule(fn: () => void, ms: number): void;
}

export function makeMemorySuggestNotify(deps: MemorySuggestNotifyDeps): (evt: UserMemoryChangeEvent) => void {
  let armed = false;
  return (evt) => {
    // A dream announces its own morning note once it finishes.
    if (evt?.action !== "created" || evt.status !== "suggested" || evt.by === "dream" || armed) return;
    armed = true;
    deps.schedule(() => {
      armed = false;
      const n = deps.pendingCount();
      if (!n) return;
      deps.fire({
        title: n === 1 ? "An agent noticed something" : `Agents noticed ${n} things`,
        body: "Review it before it's remembered.",
        workerId: "",
        route: "memory",
        ts: deps.now(),
      });
    }, MEMORY_NOTIFY_DELAY_MS);
  };
}
