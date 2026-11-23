const TIERS = [
  { tier: 1, title: "Needs you" },
  { tier: 2, title: "Working" },
  { tier: 3, title: "Quiet" },
];

// The routines as a list by what they need (08 §4.5, the field's List view):
// a row click picks the routine, its arrow opens the page.
export function RoutinesList({ discs, rows, statusOf, picked, onPick, onOpen }) {
  return (
    <div className="eos-rlist" role="group" aria-label="Your routines">
      {TIERS.map(({ tier, title }) => {
        const members = discs.filter((d) => d.tier === tier);
        if (members.length === 0) return null;
        return (
          <section key={tier} className="eos-rlist__tier" aria-label={title}>
            <h2 className="eos-label">{title}</h2>
            <ul className="eos-rlist__rows">
              {members.map((disc) => {
                const row = rows.get(disc.id);
                return (
                  <li key={disc.id} className={picked === disc.id ? "eos-rlist__row eos-rlist__row--picked" : "eos-rlist__row"}>
                    <button type="button" className="eos-rlist__pick" aria-pressed={picked === disc.id} onClick={() => onPick(disc.id)}>
                      <span className="eos-rlist__name">{row.name}</span>
                      <span className="eos-rlist__status">{picked === disc.id ? "Picked" : statusOf(disc)}</span>
                    </button>
                    <button type="button" className="eos-rlist__open" aria-label={`Open ${row.name}`} onClick={() => onOpen(disc.id)}>
                      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16"><path d="M6 3.5L10.5 8 6 12.5" /></svg>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
