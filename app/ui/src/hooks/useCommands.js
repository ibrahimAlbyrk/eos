import { useEffect, useState } from "react";
import { api } from "../api/client.js";

// Module-level cache keyed by cwd: the composer AND every user-message bubble
// consume this list (slash pills validate against it), so per-mount fetches
// would multiply with chat length. Entries revalidate in the background once
// stale; concurrent mounts share one in-flight fetch.
const TTL_MS = 60_000;
const cache = new Map(); // key → { list, at }
const inflight = new Map(); // key → Promise<list>

function fetchCommands(cwd, key) {
  let p = inflight.get(key);
  if (p) return p;
  p = api.listCommands(cwd)
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

export function useCommands(cwd) {
  const key = cwd ?? "";
  const [commands, setCommands] = useState(() => cache.get(key)?.list ?? []);

  useEffect(() => {
    let cancelled = false;
    const entry = cache.get(key);
    if (entry) setCommands(entry.list);
    if (!entry || Date.now() - entry.at > TTL_MS) {
      fetchCommands(cwd, key).then((list) => {
        if (!cancelled) setCommands(list);
      });
    }
    return () => { cancelled = true; };
  }, [key]);

  return commands;
}
