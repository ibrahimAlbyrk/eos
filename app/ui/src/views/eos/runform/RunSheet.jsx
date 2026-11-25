import { useEffect, useState } from "react";
import { useKeybinding } from "../../../keymap/useKeymap.js";
import { loadRoutine, useRoutines } from "../../../state/eos/routinesStore.js";
import { close, registerHost, useRunSheet } from "../../../state/eos/runSheetStore.js";
import { RunForm } from "./RunForm.jsx";
import { initialForm, optionsOf } from "./runFormModel.js";

const WIDTH = 460;
const GAP = 8;
const MARGIN = 16;

// Half-filled forms by routine, kept while the dashboard stays loaded: Esc
// closes the sheet, never the work in it (08 G25).
const kept = new Map();

export function keepForm(routineId, form) {
  kept.set(routineId, form);
}

export function _resetKeptForms() {
  kept.clear();
}

// Where the sheet opens, by what opened it: level with a sidebar row's Run
// button, right of the sidebar's edge, under the routine page's Run now,
// centred otherwise. A sidebar row is the sidebar door; the rest open from a
// routine's own screens.
export function sheetPlace(anchor) {
  if (!anchor?.getBoundingClientRect) return { where: "centre", door: "routine_page" };
  const side = Boolean(anchor.classList?.contains("eos-side-run"));
  const rect = anchor.getBoundingClientRect();
  if (!side) return { where: "below", door: "routine_page", rect };
  const edge = anchor.closest?.("aside")?.getBoundingClientRect().right;
  return { where: "side", door: "sidebar", rect: edge ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: edge } : rect };
}

// The sheet's position for an anchor's rectangle, kept inside the window.
export function sheetStyle({ where, rect }, viewport) {
  if (where === "centre") return undefined;
  const clampLeft = (left) => Math.max(MARGIN, Math.min(left, viewport.width - WIDTH - MARGIN));
  const top = where === "side" ? rect.top - 12 : rect.bottom + GAP;
  const left = where === "side" ? rect.right + GAP : rect.right - WIDTH;
  const shownTop = Math.max(MARGIN, Math.min(top, viewport.height - 200));
  return { top: shownTop, left: clampLeft(left), maxHeight: viewport.height - shownTop - MARGIN };
}

// Esc closes the sheet, except while the item's list is open: that Esc
// closes the list first.
export const sheetEscape = (e) => e.key === "Escape" && e.target?.getAttribute?.("aria-expanded") !== "true";

function OpenSheet({ request, routine, blueprint }) {
  const options = optionsOf(routine, blueprint);
  const [form, setFormState] = useState(() => (kept.get(routine.id) && !request.againOf && !request.input ? kept.get(routine.id) : initialForm(options, request.input, Date.now(), routine.takes?.many)));
  const setForm = (next) => {
    keepForm(routine.id, next);
    setFormState(next);
  };
  const place = sheetPlace(request.anchor);
  useKeybinding({ match: sheetEscape, priority: 1, run: (ctx, e) => { e.preventDefault(); close(); } }, []);
  const style = place.where === "centre" ? undefined : sheetStyle(place, { width: window.innerWidth, height: window.innerHeight });
  return (
    <div className={`eos-runsheet eos-runsheet--${place.where}`} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="eos-runsheet__panel" style={style}>
        <RunForm
          routine={routine}
          blueprint={blueprint}
          form={form}
          setForm={setForm}
          layout="sheet"
          door={request.door ?? place.door}
          chat={request.chat}
          againOf={request.againOf}
          autoFocus
          onCancel={close}
          onStarted={() => {
            kept.delete(routine.id);
            close();
          }}
        />
      </div>
    </div>
  );
}

// The run sheet's host, mounted once in the app: every routine's Run button
// shows, and a request opens the sheet beside it, over any mode (⌘K, a chat's
// /run).
export function RunSheet() {
  const { request } = useRunSheet();
  const { list, details } = useRoutines();
  const routineId = request?.routineId;
  useEffect(() => registerHost(), []);
  useEffect(() => { if (routineId) void loadRoutine(routineId); }, [routineId]);
  if (!request) return null;
  const detail = details[routineId];
  const routine = detail?.routine ?? list?.find((r) => r.id === routineId);
  if (!routine) return null;
  return <OpenSheet key={`${routineId}:${request.againOf ?? ""}`} request={request} routine={routine} blueprint={detail?.head?.blueprint} />;
}
