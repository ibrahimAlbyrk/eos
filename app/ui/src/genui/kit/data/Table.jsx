import { useState } from "react";
import { useView } from "../../runtime/ViewContext.jsx";
import { attrBool, parseBest, parseCols, splitIds } from "../../../../../../contracts/src/genui/attrs.ts";
import { applyLens, itemId, numberItems, sameId } from "./util.js";
import { bestCells, bestDirections, cellDisplay, nextSort, sortRows } from "./tableLogic.js";
import { FilterEmpty } from "../inputs/FilterEmpty.jsx";
import { ActionButton } from "../content/ActionButton.jsx";

function SortMark({ dir }) {
  return (
    <span className="gv-table__sort" aria-hidden="true">
      {dir === "asc" ? "↑" : dir === "desc" ? "↓" : ""}
    </span>
  );
}

export function Table({ attrs = {} }) {
  const view = useView();
  const [sort, setSort] = useState(null);
  const of = attrs.of;
  if (typeof of !== "string") return null;
  const cols = parseCols(attrs.cols);
  if (!cols.length) return null;
  const base = applyLens(view.collection(of), attrs, view.state);
  if (!base.length) return <FilterEmpty of={of} />;
  const rows = sortRows(base, sort);
  const best = bestCells(rows, bestDirections(parseBest(attrs.best), cols));
  const numbered = attrBool(attrs.numbered);
  const num = numbered ? numberItems(view.allItems(of), attrs, view.state) : null;
  const actionIds = splitIds(attrs.actions).filter((id) => view.actions?.[id]);
  const sel = view.selected(of);
  // Rows select their entity only when another lens (map, cards, chart…) shows
  // the same collection; a lone compare table is read-only.
  const selectable = (view.lensCount?.(of) ?? 0) > 1;
  const headless = cols[0].label === "";
  const minWidth = Math.max(cols.length * 104 + (actionIds.length ? 120 : 0), 320);

  return (
    <div className="gv-table" style={{ "--gv-table-min": `${minWidth}px` }}>
      <div className="gv-table__scroll">
        <table className="gv-table__table">
          <thead>
            <tr>
              {cols.map((c, ci) => {
                const dir = sort?.field === c.key ? (sort.desc ? "desc" : "asc") : null;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    className={ci === 0 ? "gv-table__lead" : undefined}
                    aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined}
                  >
                    {c.label ? (
                      <button type="button" className="gv-table__head" onClick={() => setSort(nextSort(sort, c.key))}>
                        {c.label}
                        <SortMark dir={dir} />
                      </button>
                    ) : (
                      <span className="gv-sr">{c.key}</span>
                    )}
                  </th>
                );
              })}
              {actionIds.length ? (
                <th scope="col" className="gv-table__acts">
                  <span className="gv-sr">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => {
              const id = itemId(row, ri);
              const on = selectable && sameId(sel, id);
              const pick = () => view.select(of, id);
              return (
                <tr
                  key={id}
                  className={selectable ? (on ? "is-selectable is-selected" : "is-selectable") : undefined}
                  onClick={selectable ? pick : undefined}
                >
                  {cols.map((c, ci) => {
                    const cell = cellDisplay(row, c.key);
                    const isBest = best[c.key]?.has(ri);
                    const cls = [
                      ci === 0 ? (headless ? "gv-table__rowhead" : "gv-table__lead") : null,
                      `gv-cell--${cell.kind}`,
                      isBest ? "is-best" : null,
                    ]
                      .filter(Boolean)
                      .join(" ");
                    const content =
                      ci === 0 && numbered ? (
                        <span className="gv-table__named">
                          <span className="gv-table__num" aria-hidden="true">
                            {num(row) ?? ri + 1}
                          </span>
                          {cell.text}
                        </span>
                      ) : (
                        cell.text
                      );
                    // The keyboard and screen-reader way to select a row: a
                    // pressed-state button in its lead cell (the row click is
                    // the mouse shortcut).
                    return ci === 0 ? (
                      <th key={c.key} scope="row" className={cls}>
                        {selectable ? (
                          <button
                            type="button"
                            className="gv-table__pick"
                            aria-pressed={on}
                            onClick={(e) => { e.stopPropagation(); pick(); }}
                          >
                            {content}
                          </button>
                        ) : content}
                      </th>
                    ) : (
                      <td key={c.key} className={cls}>
                        {content}
                      </td>
                    );
                  })}
                  {actionIds.length ? (
                    <td className="gv-table__acts" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      <span className="gv-table__actrow">
                        {actionIds.map((aid) => (
                          <ActionButton key={aid} id={aid} item={row} size="sm" />
                        ))}
                      </span>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
