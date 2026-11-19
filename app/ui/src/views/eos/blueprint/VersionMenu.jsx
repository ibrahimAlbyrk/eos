import { useState } from "react";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { authorWord, versionDate } from "./words.js";

// One line of the menu: number, date, who made it and its note.
export function versionLine(row) {
  return [`Version ${row.number}`, versionDate(row.createdAt), authorWord(row.author), row.note].filter(Boolean).join(" · ");
}

// "Version 7 ▾" in the card header: the routine's versions, newest first.
// Choosing one opens it read-only (eos:/routines/<id>/versions/<n>);
// choosing the version in use goes back to the editor.
export function VersionMenu({ routineId, rows, shown, inUseId, suffix = "" }) {
  const [open, setOpen] = useState(false);
  const choose = (row) => {
    setOpen(false);
    openLocation(row.id === inUseId
      ? buildLocation({ screen: "routine", routineId, tab: "blueprint" })
      : buildLocation({ screen: "version", routineId, version: row.number }));
  };
  return (
    <span className="eos-menu-wrap">
      <button type="button" className="eos-bp-card__version eos-bp-versions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        Version {shown.number}{suffix} ▾
      </button>
      {open && (
        <ul className="eos-menu eos-bp-versions__menu" role="menu" aria-label="Versions" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
          {[...rows].reverse().map((row) => (
            <li key={row.id} role="none">
              <button type="button" role="menuitemradio" aria-checked={row.id === shown.id} className="eos-menu__item" onClick={() => choose(row)}>
                {versionLine(row)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
