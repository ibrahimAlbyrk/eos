import { NavRow } from "../../agents/sidebar/NavRow.jsx";
import { useInbox } from "../../../state/eos/inboxStore.js";
import { openLocation } from "../nav/eosNav.js";

const icon = (d) => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

// Each row: where it leads, and the screens that select it.
const ROWS = [
  { label: "New routine", d: "M8 3.5v9M3.5 8h9", location: "eos:/routines/new", screens: ["new-routine"], meta: "⌘N" },
  { label: "Needs you", d: "M2.5 9.5l1.6-5h7.8l1.6 5v3h-11zM2.5 9.5h3l.8 1.5h3.4l.8-1.5h3", location: "eos:/needs", screens: ["needs", "need"], badge: true },
  { label: "Routines", d: "M3 4.5h10M3 8h10M3 11.5h6", location: "eos:/routines", screens: ["routines"] },
  { label: "Capabilities", d: "M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM11 9v4M9 11h4", location: "eos:/capabilities", screens: ["capabilities", "capability"] },
];

// The open count, as a badge that reads "3 waiting".
function Badge({ count }) {
  return <span className="eos-badge">{count}<span className="eos-sr"> waiting</span></span>;
}

// Eos's nav rows. Home and Memory join with their screens.
export function NavRows({ screen }) {
  const open = useInbox().list?.counts.open ?? 0;
  return (
    <nav className="sb-nav" aria-label="Eos">
      {ROWS.map((row) => {
        const on = row.screens.includes(screen);
        return (
          <NavRow
            key={row.label}
            icon={icon(row.d)}
            label={row.label}
            meta={row.badge ? (open > 0 ? <Badge count={open} /> : null) : row.meta}
            selected={on}
            strong={on}
            onClick={() => openLocation(row.location)}
          />
        );
      })}
    </nav>
  );
}
