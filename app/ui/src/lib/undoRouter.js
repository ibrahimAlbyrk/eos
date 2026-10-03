// Native ⌘Z/⇧⌘Z never reach the page as keys: the app menu owns them
// (app/src/main/menu.ts) and calls window.__eosUndo/__eosRedo instead. Every
// editor with its own undo stack registers a target { undo, redo, hasFocus? }.
// A target with hasFocus takes the call only while focused (a code editor);
// otherwise the most recently registered target without it does (the composer —
// a template editor mounted over it hands the keys back on unmount).

export function createUndoRouter() {
  const targets = [];
  return {
    register(target) {
      targets.push(target);
      return () => {
        const i = targets.indexOf(target);
        if (i >= 0) targets.splice(i, 1);
      };
    },
    pick() {
      const newestFirst = [...targets].reverse();
      return newestFirst.find((t) => t.hasFocus?.()) ?? newestFirst.find((t) => !t.hasFocus) ?? null;
    },
  };
}

const router = createUndoRouter();
let wired = false;

// Returns the unregister function.
export function registerUndoTarget(target) {
  if (!wired) {
    wired = true;
    window.__eosUndo = () => router.pick()?.undo();
    window.__eosRedo = () => router.pick()?.redo();
  }
  return router.register(target);
}
