import { useState } from "react";
import { ROUTES } from "../../../api/routes.js";
import { copyRoutine, deleteRoutine, setRoutineState } from "../../../state/eos/routinesStore.js";
import { openLocation } from "../nav/eosNav.js";

// The "⋯" menu's actions for a routine: Start another like this (a draft
// copy, once the core serves copies), Archive, Delete to trash.
export function menuActions(routine) {
  const actions = [];
  if (ROUTES.routineCopy) {
    actions.push({
      label: "Start another like this",
      run: async () => {
        const id = await copyRoutine(routine.id);
        if (id) openLocation(`eos:/routines/${encodeURIComponent(id)}?tab=blueprint`);
      },
    });
  }
  if (routine.state !== "archived") actions.push({ label: "Archive", run: () => setRoutineState(routine.id, "archived") });
  actions.push({
    label: "Delete to trash",
    run: async () => {
      if (await deleteRoutine(routine.id)) openLocation("eos:/");
    },
  });
  return actions;
}

export function RoutineMenu({ routine }) {
  const [open, setOpen] = useState(false);
  const choose = (action) => {
    setOpen(false);
    void action.run();
  };
  return (
    <span className="eos-menu-wrap">
      <button
        type="button"
        className="eos-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More for ${routine.name}`}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <ul className="eos-menu" role="menu" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
          {menuActions(routine).map((a) => (
            <li key={a.label} role="none">
              <button type="button" role="menuitem" className="eos-menu__item" onClick={() => choose(a)}>{a.label}</button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
