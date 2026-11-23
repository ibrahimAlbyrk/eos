import { forwardRef, useState } from "react";

// A few glyphs by the routine's icon word; any other shows its first letter.
const GLYPHS = {
  eye: "M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8zM8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z",
  branch: "M4.5 2.5v11M4.5 9.5c0-3 7-1.5 7-5M11.5 4.5v0",
  mail: "M2.5 4.5h11v7h-11zM2.5 5L8 9l5.5-4",
  paper: "M3 3.5h8v9H4a1 1 0 0 1-1-1zM11 6h2v5.5a1 1 0 0 1-1 1M5 6h4M5 8.3h4M5 10.5h2.5",
  pulse: "M2 8.5h2.8l1.6-4 3 7.5 1.6-3.5H14",
  calendar: "M3 4.5h10V13H3zM3 7h10M5.5 3v2.5M10.5 3v2.5",
  notes: "M3.5 4.5h9M3.5 8h9M3.5 11.5h5",
};

function Glyph({ icon, name, size }) {
  const d = GLYPHS[icon];
  if (!d) return <span className="eos-disc__letter" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>;
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" className="eos-disc__glyph"><path d={d} /></svg>;
}

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
        <span className="eos-disc__face"><Glyph icon={row.icon} name={row.name} size={Math.round(d * 0.21)} /></span>
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
