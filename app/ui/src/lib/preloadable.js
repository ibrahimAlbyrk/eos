// A code-split module that start-up loads once the first paint is done (main.jsx), so
// it is in memory before anyone opens what it draws. `value` is the loaded module, or
// null until then; `load()` starts the load once and answers the module. A failed load
// is forgotten, so the next `load()` tries again.
export function preloadable(load) {
  let value = null;
  let pending = null;
  return {
    get value() {
      return value;
    },
    load() {
      pending ??= load().then(
        (mod) => (value = mod),
        (err) => { pending = null; throw err; },
      );
      return pending;
    },
  };
}
