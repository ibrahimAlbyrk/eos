import { forwardRef, useState } from "react";
import { RoutineGlyph } from "../routines/RoutineGlyph.jsx";

// One routine on the field (HomeField.dc.html, RunInput.dc.html): its disc,
// sized by how much it does and ringed by what it needs, its name and status
// under it, and a small arrow that opens its page. A click picks it for the
// input; a file or link dropped on it starts a run (D40).
export const Disc = forwardRef(function Disc({ place, delay = 0, row, status, picked, dim, focusable, onPick, onOpen, onDrop, onFocus }, ref) {
  const [over, setOver] = useState(false);
  const tierClass = row.kind === "project" ? "eos-disc--project" : `eos-disc--t${place.tier}`;
  const classes = ["eos-disc", tierClass, place.compact && "eos-disc--compact", picked && "eos-disc--picked", over && "eos-disc--over"].filter(Boolean).join(" ");
  const d = Math.round(place.d);
  return (
    <div
      className={classes}
      style={{ "--x": `${place.x}px`, "--y": `${place.y}px`, "--d": `${d}px`, "--dd": `${Math.round(delay)}ms`, "--dim": dim ? 0.3 : 1 }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onDrop(e); }}
    >
      <button
        ref={ref}
        type="button"
        className="eos-disc__pick"
        tabIndex={focusable ? 0 : -1}
        aria-pressed={picked}
        aria-label={`${row.name}. ${picked ? "Picked" : status}`}
        onClick={onPick}
        onFocus={onFocus}
      >
        <span className="eos-disc__face"><RoutineGlyph icon={row.icon} name={row.name} size={Math.round(d * 0.21)} part="eos-disc" /></span>
        <span className="eos-disc__label" aria-hidden="true">
          <span className="eos-disc__name">{row.name}</span>
          <span className="eos-disc__status">{picked ? "Picked" : status}</span>
        </span>
      </button>
      <button type="button" className="eos-disc__open" tabIndex={-1} aria-label={`Open ${row.name}`} onClick={onOpen}>
        <svg aria-hidden="true" width="10" height="10" viewBox="0 0 16 16"><path d="M5 11l6-6M6 5h5v5" /></svg>
      </button>
    </div>
  );
});

// "+N": the routines of a ring that found no place; it opens the List.
export function PlusDisc({ place, onOpen }) {
  return (
    <div className="eos-disc eos-disc--plus" style={{ "--x": `${place.x}px`, "--y": `${place.y}px`, "--d": "60px" }}>
      <button type="button" className="eos-disc__pick" tabIndex={-1} aria-label={`${place.count} more. Show the list`} onClick={onOpen}>
        <span className="eos-disc__face">+{place.count}</span>
      </button>
    </div>
  );
}
