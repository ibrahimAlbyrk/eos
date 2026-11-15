import { useSyncExternalStore } from "react";

// One shared 1 s clock for text derived from the time ("5m ago", an elapsed
// counter): every reader re-renders on the same beat, and only the readers.
const TICK_MS = 1000;

let now = Date.now();
let timer = 0;
const subs = new Set();

function tick() {
  now = Date.now();
  for (const cb of subs) cb();
}

export function subscribeClock(cb) {
  subs.add(cb);
  if (!timer) {
    now = Date.now();
    timer = setInterval(tick, TICK_MS);
  }
  return () => {
    subs.delete(cb);
    if (subs.size === 0 && timer) { clearInterval(timer); timer = 0; }
  };
}

// While nobody listens the clock stands still; a first reader must not draw a
// stale time, so the value catches up in whole ticks (stable within a tick).
export function getNow() {
  if (!timer && Date.now() - now >= TICK_MS) now = Date.now();
  return now;
}

const noSubscribe = () => () => {};

// The current time, re-rendering the caller every second. `enabled` false
// leaves the caller alone (it reads nothing that changes with the time).
export function useNow(enabled = true) {
  return useSyncExternalStore(enabled ? subscribeClock : noSubscribe, getNow, getNow);
}

const getToday = () => new Date(getNow()).toDateString();

// Today's local date; re-renders the caller only when the day changes.
export function useToday() {
  return useSyncExternalStore(subscribeClock, getToday, getToday);
}
