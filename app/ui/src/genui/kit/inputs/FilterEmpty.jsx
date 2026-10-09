// The empty state every collection lens shows when the shared Filters chips
// leave nothing, plus the chip helpers Filters itself uses.

import { useView } from "../../runtime/ViewContext.jsx";

// Indices of the chips that are on. view.filters(name) is a chip list
// ({index, label, where, on}); index arrays and Sets are read too.
export function activeChips(filters) {
  if (!filters) return [];
  const list = filters instanceof Set ? [...filters] : Array.isArray(filters) ? filters : null;
  if (list) {
    return list
      .map((f, i) => (Number.isInteger(f) ? f : f && typeof f === "object" ? (f.on ? (Number.isInteger(f.index) ? f.index : i) : null) : null))
      .filter((i) => Number.isInteger(i));
  }
  if (typeof filters === "object") {
    return Object.entries(filters)
      .filter(([, on]) => on)
      .map(([k]) => Number(k))
      .filter((i) => Number.isInteger(i));
  }
  return [];
}

export function chipIsOn(filters, index) {
  return activeChips(filters).includes(index);
}

// Turns every active chip of a collection off in one write (toggling them one by
// one would not work: each toggle reads the same render's chip list).
export function clearFilters(view, of) {
  view.clearFilters?.(of);
}

// True when the shared chips (not the element's own where=) hide every item of
// a collection that has items.
export function filteredOut(view, of) {
  if (typeof of !== "string") return false;
  const all = view.allItems(of) ?? [];
  const shown = view.collection(of) ?? [];
  return all.length > 0 && shown.length === 0 && activeChips(view.filters(of)).length > 0;
}

// One empty state per collection: the Filters element draws it under its chips
// (`standalone`); every lens of that collection renders nothing in its place, so
// hero, carousel and table don't each repeat it. Renders nothing when the
// emptiness isn't the chips' doing.
export function FilterEmpty({ of, compact = false, standalone = false }) {
  const view = useView();
  if (!standalone || !filteredOut(view, of)) return null;
  return (
    <div className={`gv-fempty${compact ? " is-compact" : ""}`} role="status">
      <div className="gv-fempty__title">Nothing matches these filters</div>
      {compact ? null : <div className="gv-fempty__text">Loosen the filters, or ask for a wider search.</div>}
      <button type="button" className="gv-btn gv-btn-glass gv-btn-sm" onClick={() => clearFilters(view, of)}>
        Clear filters
      </button>
    </div>
  );
}
