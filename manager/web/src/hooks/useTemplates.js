import { useEffect, useState } from "react";
import { api } from "../api/client.js";

// Module-level shared cache so the composer slash menu, the picker popover
// and the ⌘K palette all see the same list without each refetching. CRUD
// callers mutate via api.* then call refreshTemplates() to fan out updates.

let cache = null;
const listeners = new Set();

function emit() {
  for (const fn of listeners) fn(cache ?? []);
}

async function load() {
  try {
    const r = await api.listTemplates();
    cache = r.templates ?? [];
  } catch {
    cache = cache ?? [];
  }
  emit();
}

export async function refreshTemplates() {
  await load();
}

export function useTemplates() {
  const [templates, setTemplates] = useState(cache ?? []);

  useEffect(() => {
    listeners.add(setTemplates);
    if (cache === null) load();
    else setTemplates(cache);
    return () => listeners.delete(setTemplates);
  }, []);

  return templates;
}
