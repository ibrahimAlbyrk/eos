// Async facade over highlightTokens: runs the Lezer parse in a Web Worker so
// the main thread never stalls on a big hunk, with a bounded result cache so
// re-renders and panel reopens resolve instantly. Environments without Worker
// (tests) fall back to a synchronous parse.

const MAX_CACHE = 400;
const cache = new Map();
const pending = new Map();
let worker;
let seq = 0;

// The sync tokenizer is only needed when the Worker is unavailable (tests) or
// dies mid-flight. Load it on demand so the ~25 Lezer grammars stay out of the
// eager main bundle — the Worker carries its own copy for the normal path.
let syncTokensP = null;
function syncTokens() {
  if (!syncTokensP) syncTokensP = import("./highlightTokens.js").then((m) => m.highlightToTokenLines);
  return syncTokensP;
}

function cachePut(key, lines) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, lines);
}

function workerInstance() {
  if (worker !== undefined) return worker;
  if (typeof Worker === "undefined") {
    worker = null;
    return worker;
  }
  try {
    worker = new Worker(new URL("./highlight.worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      cachePut(p.key, e.data.lines);
      p.resolve(e.data.lines);
    };
    // A dead worker must not strand callers — fail over to sync once.
    worker.onerror = () => {
      const stranded = [...pending.values()];
      pending.clear();
      syncTokens().then((fn) => { for (const p of stranded) p.resolve(fn(p.code, p.filePath)); });
      worker.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

// Returns a promise of one token array per line ({t, c}), or null when the
// language is unknown.
export function highlightAsync(code, filePath) {
  if (!code || !filePath) return Promise.resolve(null);
  const key = filePath.split("/").pop() + "\0" + code;
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  const w = workerInstance();
  if (!w) {
    return syncTokens().then((fn) => {
      const lines = fn(code, filePath);
      cachePut(key, lines);
      return lines;
    });
  }
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, { key, code, filePath, resolve });
    w.postMessage({ id, code, filePath });
  });
}
