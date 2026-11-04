// A plugin's stored values (useStore), cached per plugin and key. Reads come
// from the daemon once; writes show at once and reach the daemon after a short
// pause (typing into a note is one write, not one per key); another window's
// write arrives as plugin:<id>:store and is read again.

import { useEffect, useSyncExternalStore } from "react";
import { api } from "../api/client.js";
import { onTopic } from "../lib/liveTopics.js";

const WRITE_DELAY_MS = 300;

const values = new Map(); // "<id>\n<key>" → value (absent = not read yet)
const subs = new Map(); // same key → Set<cb>
const pendingWrites = new Map(); // same key → timer
const followed = new Set(); // plugin ids whose store topic is followed

const k = (id, key) => `${id}\n${key}`;

function emit(key) {
  for (const cb of subs.get(key) ?? []) cb();
}

async function read(id, key) {
  try {
    const v = await api.getPluginValue(id, key);
    // A write still on its way is newer than what the daemon has.
    if (pendingWrites.has(k(id, key))) return;
    values.set(k(id, key), v);
    emit(k(id, key));
  } catch {}
}

function follow(id) {
  if (followed.has(id)) return;
  followed.add(id);
  onTopic(`plugin:${id}:store`, (p) => {
    if (p?.key && values.has(k(id, p.key))) void read(id, p.key);
  });
}

export function setPluginValue(id, key, value) {
  const ck = k(id, key);
  values.set(ck, value);
  emit(ck);
  clearTimeout(pendingWrites.get(ck));
  pendingWrites.set(ck, setTimeout(async () => {
    pendingWrites.delete(ck);
    const r = await api.setPluginValue(id, key, value);
    if (!r.ok) console.error(`Plugin "${id}" couldn't save "${key}":`, r.body?.error ?? r.status);
  }, WRITE_DELAY_MS));
}

// [value, set] — `initial` until the stored value has been read (or when none is stored).
export function usePluginValue(id, key, initial) {
  const ck = k(id, key);
  const subscribe = (cb) => {
    let set = subs.get(ck);
    if (!set) subs.set(ck, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  };
  const get = () => values.get(ck);
  const value = useSyncExternalStore(subscribe, get, get);
  useEffect(() => {
    follow(id);
    if (!values.has(ck)) void read(id, key);
  }, [id, key, ck]);
  const set = (next) => setPluginValue(id, key, typeof next === "function" ? next(values.get(ck) ?? initial) : next);
  return [value ?? initial, set];
}
