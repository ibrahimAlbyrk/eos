import { useEffect, useReducer } from "react";
import { api } from "../api/client.js";

// The live worker list carries a clipped boot prompt (prompt_clipped); the task
// card needs the whole text. A prompt never changes after spawn, so it is
// fetched once per worker and kept.
const fullPrompts = new Map();

export function useWorkerPrompt(worker) {
  const id = worker?.id;
  const clipped = worker?.prompt_clipped === true;
  const [, rerender] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    if (!clipped || fullPrompts.has(id)) return;
    let live = true;
    api.getWorker(id)
      .then((w) => {
        if (typeof w?.prompt !== "string") return;
        fullPrompts.set(id, w.prompt);
        if (live) rerender();
      })
      .catch(() => {});
    return () => { live = false; };
  }, [id, clipped]);
  if (!worker) return null;
  return clipped ? (fullPrompts.get(id) ?? worker.prompt) : worker.prompt;
}
