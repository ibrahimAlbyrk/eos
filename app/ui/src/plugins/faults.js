// The latest load problem of each plugin in this window (shown in Settings ›
// Plugins next to the daemon's own build errors).

const faults = new Map(); // id → { rev, message }
const subs = new Set();

export function pluginFault(id) {
  return faults.get(id) ?? null;
}

export function subscribePluginFaults(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function setPluginFault(id, fault) {
  if (fault) faults.set(id, fault);
  else if (!faults.delete(id)) return;
  for (const cb of subs) cb();
}

export const faultedPlugins = () => [...faults.keys()];
