import { useState } from "react";
import { useMenuDismiss } from "../menu/useMenuDismiss.js";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { authorWord, versionDate } from "./words.js";

// One line of the menu: number, date, who made it and its note.
export function versionLine(row) {
  return [`Version ${row.number}`, versionDate(row.createdAt), authorWord(row.author), row.note].filter(Boolean).join(" · ");
}

// Where a version stands, beside its number in the menu.
const standing = (row, inUseId) => (row.id === inUseId ? "In use" : row.status === "draft" ? "Not in use yet" : null);

// "Version 7 ▾" in the card header: the routine's versions, newest first.
// Choosing one opens it read-only (eos:/routines/<id>/versions/<n>);
// choosing the version in use goes back to the editor.
export function VersionMenu({ routineId, rows, shown, inUseId, suffix = "" }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useMenuDismiss(open, () => setOpen(false));
  const choose = (row) => {
    setOpen(false);
    openLocation(row.id === inUseId
      ? buildLocation({ screen: "routine", routineId, tab: "blueprint" })
      : buildLocation({ screen: "version", routineId, version: row.number }));
  };
  return (
    <span className="eos-menu-wrap" ref={wrapRef}>
      <button type="button" className="eos-bp-card__version eos-bp-versions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        Version {shown.number}{suffix} ▾
      </button>
      {open && (
        <ul className="eos-menu eos-bp-versions__menu" role="menu" aria-label="Versions" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
          {[...rows].reverse().map((row) => (
            <li key={row.id} role="none">
              <button type="button" role="menuitemradio" aria-checked={row.id === shown.id} aria-label={versionLine(row)} className="eos-menu__item eos-bp-versions__item" onClick={() => choose(row)}>
                <span className="eos-bp-versions__top">
                  <span className="eos-bp-versions__num">Version {row.number}</span>
                  {standing(row, inUseId) && <span className="eos-bp-versions__state">{standing(row, inUseId)}</span>}
                </span>
                <span className="eos-bp-versions__line">{versionLine(row).split(" · ").slice(1).join(" · ")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
