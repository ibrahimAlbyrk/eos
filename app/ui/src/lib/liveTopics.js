// Handlers for daemon bus topics that reach the UI over the SSE stream, added
// at runtime (a plugin's own topics, …). useLive offers every event here before
// its built-in routing, and calls the resync handlers when the stream could not
// replay what this window missed.
//
// Plugin topics are named "plugin:<pluginId>:<event>". They are never worker
// deltas, so an unhandled one is dropped instead of triggering a workers refetch.

const handlers = new Map(); // topic → Set<fn(payload)>
const resyncs = new Set();

export const PLUGIN_TOPIC_PREFIX = "plugin:";

export function onTopic(topic, fn) {
  let set = handlers.get(topic);
  if (!set) handlers.set(topic, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0 && handlers.get(topic) === set) handlers.delete(topic);
  };
}

export function onResync(fn) {
  resyncs.add(fn);
  return () => resyncs.delete(fn);
}

// True when the event is fully handled here (useLive stops routing it).
export function dispatchTopic(topic, payload) {
  const set = handlers.get(topic);
  if (set) for (const fn of [...set]) runSafely(fn, payload);
  return Boolean(set) || topic?.startsWith(PLUGIN_TOPIC_PREFIX);
}

export function dispatchResync() {
  for (const fn of [...resyncs]) runSafely(fn);
}

function runSafely(fn, arg) {
  try {
    fn(arg);
  } catch (e) {
    console.error("Live topic handler failed:", e);
  }
}
