import { useState } from "react";
import { copyRoutine, deleteRoutine, exportRoutine, setRoutineState } from "../../../state/eos/routinesStore.js";
import { openLocation } from "../nav/eosNav.js";

// A file name from the routine's name.
export const fileName = (name) =>
  `${(name || "routine").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "routine"}.eos-routine.json`;

// Hands the routine's file to the browser to save.
async function saveToFile(routine) {
  const file = await exportRoutine(routine.id);
  if (!file) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName(routine.name);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// The "⋯" menu's actions for a routine: Start another like this (a draft
// copy), Save to a file, Archive, Delete to trash.
export function menuActions(routine) {
  const actions = [{
    label: "Start another like this",
    run: async () => {
      const id = await copyRoutine(routine.id);
      if (id) openLocation(`eos:/routines/${encodeURIComponent(id)}?tab=blueprint`);
    },
  }, { label: "Save to a file", run: () => saveToFile(routine) }];
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
