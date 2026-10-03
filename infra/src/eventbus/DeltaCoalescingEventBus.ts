// Live token deltas (`agent:delta`) arrive one per model chunk — dozens a second
// per streaming block, each a frame on every stream (dashboard tabs, phones,
// peer links) with a couple of hundred bytes around a few characters.
//
// This bus passes a block's first delta straight through, then holds the next
// ones for `windowMs` and merges them into one (text appended, `at` and phase of
// the first kept). Anything else published — a stop, another topic — first
// releases what is held, so a block's deltas never trail the events after them.

import type { EventBus, EventBusTopic } from "../../../core/src/ports/EventBus.ts";

interface Delta {
  workerId: string;
  blockId: string;
  channel?: unknown;
  phase?: unknown;
  text: string;
  [k: string]: unknown;
}

interface Slot {
  held: Delta | null;
  timer: ReturnType<typeof setTimeout>;
}

function asDelta(payload: unknown): Delta | null {
  const p = payload as Partial<Delta> | null;
  if (!p || typeof p.workerId !== "string" || typeof p.blockId !== "string" || typeof p.text !== "string") return null;
  return p.phase === "start" || p.phase === "append" ? (p as Delta) : null;
}

export function withCoalescedDeltas(bus: EventBus, opts: { windowMs: number }): EventBus {
  const slots = new Map<string, Slot>();

  const release = (): void => {
    for (const slot of slots.values()) {
      if (!slot.held) continue;
      const held = slot.held;
      slot.held = null;
      bus.publish("agent:delta", held);
    }
  };

  // Window over: send what piled up and keep the window open while the block streams.
  const close = (key: string): void => {
    const slot = slots.get(key);
    if (!slot) return;
    if (!slot.held) { slots.delete(key); return; }
    const held = slot.held;
    slot.held = null;
    slot.timer = arm(key);
    bus.publish("agent:delta", held);
  };

  const arm = (key: string): ReturnType<typeof setTimeout> => {
    const t = setTimeout(() => close(key), opts.windowMs);
    t.unref?.();
    return t;
  };

  return {
    publish(topic: EventBusTopic, payload: unknown): void {
      const delta = topic === "agent:delta" ? asDelta(payload) : null;
      if (!delta) {
        release();
        if (topic === "agent:delta") {
          const p = payload as Partial<Delta> | null;
          const key = `${p?.workerId}\0${p?.blockId}`;
          const slot = slots.get(key);
          if (slot) { clearTimeout(slot.timer); slots.delete(key); }
        }
        bus.publish(topic, payload);
        return;
      }
      const key = `${delta.workerId}\0${delta.blockId}`;
      const slot = slots.get(key);
      // A (re)start resets the block's text — it can't fold into held appends.
      if (!slot || delta.phase === "start") {
        if (slot) { release(); clearTimeout(slot.timer); }
        slots.set(key, { held: null, timer: arm(key) });
        bus.publish(topic, payload);
        return;
      }
      if (slot.held && slot.held.channel !== delta.channel) {
        const held = slot.held;
        slot.held = null;
        bus.publish("agent:delta", held);
      }
      slot.held = slot.held ? { ...slot.held, text: slot.held.text + delta.text } : { ...delta };
    },
    subscribe: (topic, fn) => bus.subscribe(topic, fn),
  };
}
