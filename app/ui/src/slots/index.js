// The UI's extension points. Built-in features and plugins add items the same
// way; the host components render whatever each slot holds.
//
//   headerRight  { id, order, once?, Component({ live, worker, topRight }) }
//                Right side of a pane header. `once` items show only in the
//                top-right pane (one per window).
//   sidebarNav   { id, order, Component({ live }) }      — a custom row, or
//                { id, order, label, icon, view }        — a row that opens main view `view`
//                Rows under the Eos switcher (New task, Changes, Archive, …).
//   mainViews    { id, Component({ live }) }
//                Takes over the Agents main area while active (see mainView.js).

import { createSlot } from "./registry.js";

export const headerRight = createSlot();
export const sidebarNav = createSlot();
export const mainViews = createSlot();

export { getMainView, setMainView, closeMainView, useMainView } from "./mainView.js";
