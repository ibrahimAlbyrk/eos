// One element's props from several delegated-handler hooks (path links,
// artifact links): handlers of the same name run in the order given.
export function joinHandlers(...sets) {
  const out = {};
  for (const set of sets) {
    for (const [name, fn] of Object.entries(set)) {
      const prev = out[name];
      out[name] = prev ? (e) => { prev(e); fn(e); } : fn;
    }
  }
  return out;
}
