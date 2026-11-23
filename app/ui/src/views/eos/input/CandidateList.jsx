import { chipLabel } from "../runform/runFormModel.js";

export const LIST_ID = "eos-input-list";

// The list under the input (RunInput.dc.html): the user's routines after `/`,
// or the routine token's candidate items. An APG listbox the text field
// drives (aria-activedescendant); a row is chosen on mouse down so the field
// keeps focus.
export function CandidateList({ title, rows, active, onChoose, foot }) {
  if (rows.length === 0) return null;
  return (
    <div className="eos-cands">
      {title && <div className="eos-cands__title">{title}</div>}
      <ul id={LIST_ID} role="listbox" className="eos-cands__list" aria-label={title}>
        {rows.map((row, i) => (
          <li
            key={row.key}
            id={`${LIST_ID}-${i}`}
            role="option"
            aria-selected={i === active}
            className="eos-cands__row"
            onMouseDown={(e) => { e.preventDefault(); onChoose(i); }}
          >
            {row.mark && <span className="eos-cands__mark">{row.mark}</span>}
            <span className="eos-cands__name">{row.name}</span>
            {row.aside && <span className="eos-cands__aside">{row.aside}</span>}
          </li>
        ))}
      </ul>
      {foot && <div className="eos-cands__foot">{foot}</div>}
    </div>
  );
}

// The routines a `/` query names, by name or slug.
export function menuRows(routines, query) {
  const q = query.replace(/^\//, "").trim().toLowerCase();
  return routines
    .filter((r) => !q || r.name.toLowerCase().includes(q) || r.slug?.includes(q))
    .map((r) => ({ key: r.id, name: r.name, aside: r.summary ?? null, routine: r }));
}

// A candidate item as a row: its number, its title, and what is known of it.
export function itemRows(items) {
  return items.map((item, i) => ({ key: item.key ?? String(i), mark: chipLabel(item), name: item.title ?? item.text ?? item.url ?? "", aside: item.note ?? null, item }));
}
