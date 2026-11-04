// A slot is one place in the UI that features (built-in or plugin) fill with
// items. Items can come and go at runtime — a plugin reload removes its items and
// adds the new ones — so every slot is a small reactive list: `add` returns the
// function that removes the item again, and `useItems` re-renders on any change.
// An item added with an id that is already present replaces it in place.

import { useSyncExternalStore } from "react";

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);

export function createSlot() {
  let items = [];
  const subs = new Set();
  const emit = () => { for (const cb of subs) cb(); };

  function add(item) {
    items = [...items.filter((i) => i.id !== item.id), item].sort(byOrder);
    emit();
    return () => {
      if (!items.includes(item)) return;
      items = items.filter((i) => i !== item);
      emit();
    };
  }

  const list = () => items;
  const get = (id) => items.find((i) => i.id === id) ?? null;
  const subscribe = (cb) => {
    subs.add(cb);
    return () => subs.delete(cb);
  };
  const useItems = () => useSyncExternalStore(subscribe, list, list);

  return { add, list, get, subscribe, useItems };
}
