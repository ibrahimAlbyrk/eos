// fieldStore — whether Home shows the field (08 §4.5, §4.6): the input took
// focus, so Home turned into the routines around it. The field is never
// stored; the viewer's choice of Field or List is, as `eos:fieldView`
// (`auto` opens the List only when a ring overflows).

import { useSyncExternalStore } from "react";

export const FIELD_VIEW_KEY = "eos:fieldView";
const VIEWS = new Set(["auto", "field", "list"]);

let state = { open: false, view: null };
const subs = new Set();

function set(patch) {
  state = { ...state, ...patch };
  for (const cb of subs) cb();
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

function storedView() {
  try {
    const v = localStorage.getItem(FIELD_VIEW_KEY);
    return VIEWS.has(v) ? v : "auto";
  } catch {
    return "auto";
  }
}

const snapshot = () => {
  if (state.view === null) state = { ...state, view: storedView() };
  return state;
};

export function useField() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function openField() {
  if (!state.open) set({ open: true });
}

export function closeField() {
  if (state.open) set({ open: false });
}

export function setFieldView(view) {
  set({ view });
  try {
    localStorage.setItem(FIELD_VIEW_KEY, view);
  } catch {}
}

// The view the field shows: the viewer's choice, else Field unless a ring
// overflows.
export const shownView = (view, fits) => (view === "auto" ? (fits ? "field" : "list") : view);

export function _resetField() {
  state = { open: false, view: null };
}
