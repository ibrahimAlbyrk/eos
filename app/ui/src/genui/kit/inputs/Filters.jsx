import { useView } from "../../runtime/ViewContext.jsx";
import { parseChips } from "../../../../../../contracts/src/genui/attrs.ts";
import { Icon } from "../icons.jsx";
import { FilterEmpty, activeChips } from "./FilterEmpty.jsx";

// Chips bound to a collection: each toggles a where= filter that every lens of
// that collection (cards, pins, rows) applies. The runtime owns which are on.
export function chipList(view, of, chipsAttr) {
  const fromRuntime = typeof of === "string" ? view.filters(of) : [];
  if (Array.isArray(fromRuntime) && fromRuntime.length && typeof fromRuntime[0] === "object") return fromRuntime;
  // Not registered (a view still streaming in): show the chips, all off.
  const on = new Set(activeChips(fromRuntime));
  return parseChips(chipsAttr).map((c, index) => ({ ...c, index, on: on.has(index) }));
}

export function Filters({ attrs = {} }) {
  const view = useView();
  const of = typeof attrs.of === "string" ? attrs.of : null;
  if (!of) return null;
  const chips = chipList(view, of, attrs.chips);
  if (!chips.length) return null;
  const total = view.allItems(of).length;
  const shown = view.collection(of).length;
  return (
    <>
    <div className="gv-filters" role="group" aria-label="Filters">
      <div className="gv-filters__chips">
        {chips.map((c) => (
          <button
            type="button"
            key={c.index}
            className={`gv-fchip${c.on ? " is-on" : ""}`}
            aria-pressed={Boolean(c.on)}
            title={c.label !== c.where ? c.where : undefined}
            onClick={() => view.toggleFilter(of, c.index)}
          >
            {c.on ? <Icon name="check" size={13} stroke={2.4} /> : null}
            {c.label}
          </button>
        ))}
      </div>
      {total ? (
        <span className="gv-filters__count" aria-live="polite">
          {shown === total ? total : `${shown} of ${total}`}
        </span>
      ) : null}
    </div>
    <FilterEmpty of={of} standalone />
    </>
  );
}
