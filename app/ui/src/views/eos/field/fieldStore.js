// fieldStore — whether Home shows the field (08 §4.5, §4.6): the input took
// focus, so Home turned into the routines around it. `phase` is where the
// transition is (transition.js); `on` is whether Home and the field are
// heading to the field, which the CSS transitions follow, so turning round
// reverses every moving part from its current value. The field is never
// stored; the viewer's choice of Field or List is, as `eos:fieldView`
// (`auto` opens the List only when a ring overflows).

import { useSyncExternalStore } from "react";
import { nextPhase, phaseMs, reducedMotion } from "./transition.js";

export const FIELD_VIEW_KEY = "eos:fieldView";
const VIEWS = new Set(["auto", "field", "list"]);

let state = { phase: "home", on: false, open: false, view: null };
let timer = null;
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

function go(event) {
  const phase = nextPhase(state.phase, event);
  if (phase === state.phase) return;
  clearTimeout(timer);
  const from = state.phase;
  set({ phase, open: phase !== "home", on: phase === "field" || (phase === "entering" && from === "leaving") });
  if (phase === "entering" && from === "home") nextFrame(armField);
  const ms = phaseMs(phase, reducedMotion());
  if (ms > 0) timer = setTimeout(() => go("ended"), ms);
}

// The field's parts are drawn in their Home state first; one frame later
// they head for the field, so the browser has a start to move from.
function nextFrame(cb) {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(cb));
  else setTimeout(cb, 0);
}

export function armField() {
  if (state.phase === "entering" && !state.on) set({ on: true });
}

export function openField() {
  go("open");
}

export function closeField() {
  go("leave");
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
  clearTimeout(timer);
  state = { phase: "home", on: false, open: false, view: null };
}
