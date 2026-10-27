// The editors installed on the Mac this view drives (GET /fs/editors), asked
// once per window. A view of another computer has no editor to open on its
// screen, so it gets none. Module singleton (the hostsStore idiom).

import { useEffect, useSyncExternalStore } from "react";
import { api } from "../api/client.js";
import { hasLocalScreen } from "../lib/host.js";

const NONE = [];
let editors = NONE;
let started = false;
const subs = new Set();

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}
const get = () => editors;

function ensureLoaded() {
  if (started || !hasLocalScreen()) return;
  started = true;
  api.listEditors().then(
    (list) => { editors = list; for (const cb of subs) cb(); },
    () => { started = false; },
  );
}

// → [{ id, name }]
export function useEditors() {
  useEffect(ensureLoaded, []);
  return useSyncExternalStore(subscribe, get, get);
}

// The editor a path opens in: the one chosen in Settings when it is installed,
// else the first installed one, else null.
export function preferredEditor(list, chosen) {
  return list.find((e) => e.id === chosen) ?? list[0] ?? null;
}
