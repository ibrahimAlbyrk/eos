// In-memory pub/sub. Subscribers are invoked synchronously in their
// subscribe order. Errors in one subscriber don't affect others.

import type { EventBus, EventBusTopic, EventBusSubscriber } from "../../../core/src/ports/EventBus.ts";

export function createInMemoryEventBus(): EventBus {
  const subs = new Map<EventBusTopic | "*", Set<EventBusSubscriber>>();

  const subscribersFor = (topic: EventBusTopic): Iterable<EventBusSubscriber> => {
    const exact = subs.get(topic);
    const wild = subs.get("*");
    if (!exact && !wild) return [];
    if (!wild) return exact!;
    if (!exact) return wild;
    // Cheap merge — small sets in practice.
    return new Set([...exact, ...wild]);
  };

  return {
    publish(topic, payload) {
      const msg = { topic, payload, ts: Date.now() } as const;
      for (const fn of subscribersFor(topic)) {
        try { fn(msg); } catch { /* per-subscriber failure shouldn't poison the bus */ }
      }
    },
    subscribe(topic, fn) {
      let set = subs.get(topic);
      if (!set) {
        set = new Set();
        subs.set(topic, set);
      }
      set.add(fn);
      return () => { set!.delete(fn); };
    },
  };
}
