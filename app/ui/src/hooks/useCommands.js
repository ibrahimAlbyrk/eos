import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { afterFirstPaint } from "../lib/firstPaint.js";

// Module-level cache keyed by cwd: the composer AND every user-message bubble
// consume this list (slash pills validate against it), so per-mount fetches
// would multiply with chat length. Entries revalidate in the background once
// stale; concurrent mounts share one in-flight fetch.
const TTL_MS = 60_000;
// A worker's list grows as its session finds skills in the folders it
// touches: it is read again when the worker's state changes (a turn ends).
const WORKER_TTL_MS = 5_000;
const cache = new Map(); // key → { list, at }
const inflight = new Map(); // key → Promise<list>

function fetchCommands(cwd, workerId, key) {
  let p = inflight.get(key);
  if (p) return p;
  p = afterFirstPaint(() => api.listCommands(cwd, workerId))
    .then((r) => {
      const list = r.commands ?? [];
      cache.set(key, { list, at: Date.now() });
      return list;
    })
    .catch(() => cache.get(key)?.list ?? [])
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// `workerId` (the composer's): the worker's live session's finds are listed
// too; a new `workerState` reads a stale list again.
export function useCommands(cwd, workerId = null, workerState = null) {
  const key = workerId ? `${cwd ?? ""}\0${workerId}` : cwd ?? "";
  const ttl = workerId ? WORKER_TTL_MS : TTL_MS;
  const [commands, setCommands] = useState(() => cache.get(key)?.list ?? []);

  useEffect(() => {
    let cancelled = false;
    const entry = cache.get(key);
    if (entry) setCommands(entry.list);
    if (!entry || Date.now() - entry.at > ttl) {
      fetchCommands(cwd, workerId, key).then((list) => {
        if (!cancelled) setCommands(list);
      });
    }
    return () => { cancelled = true; };
  }, [key, workerState]);

  return commands;
}
