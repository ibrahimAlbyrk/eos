import { useView } from "../../runtime/ViewContext.jsx";
import { attrBool, attrText } from "../../../../../../contracts/src/genui/attrs.ts";
import { applyLens, itemId, itemName, numberItems, sameId } from "./util.js";
import { FilterEmpty } from "../inputs/FilterEmpty.jsx";

function text(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

// One stop's lines: the template attrs when given, else the usual fields.
export function timelineStop(view, attrs, item) {
  const pick = (attr, fallback) => (attrs[attr] !== undefined ? view.template(attrText(attrs[attr]), item) : fallback);
  return {
    time: pick("time", text(item.time ?? item.start ?? item.at)),
    title: pick("title", itemName(item)),
    note: pick("note", text(item.note ?? item.excerpt)),
    meta: pick("meta", text(item.dur ?? item.duration)),
    leg: pick("leg", text(item.leg)),
  };
}

export function Timeline({ attrs = {} }) {
  const view = useView();
  const of = attrs.of;
  if (typeof of !== "string") return null;
  const items = applyLens(view.collection(of), attrs, view.state);
  if (!items.length) return <FilterEmpty of={of} />;
  const numbered = attrBool(attrs.numbered);
  const num = numberItems(view.allItems(of), attrs, view.state);
  const sel = view.selected(of);
  const stops = items.map((it, i) => ({ it, id: itemId(it, i), ...timelineStop(view, attrs, it) }));
  const hasTime = stops.some((s) => s.time);
  return (
    <ol className={`gv-tl${hasTime ? "" : " gv-tl--notime"}${numbered ? " gv-tl--numbered" : ""}`}>
      {stops.map((s, i) => {
        const on = sameId(sel, s.id);
        const n = num(s.it) ?? i + 1;
        return (
          <li className="gv-tl__item" key={s.id}>
            <button type="button" className={`gv-tl__stop${on ? " is-selected" : ""}`} aria-pressed={on} onClick={() => view.select(of, s.id)}>
              {hasTime ? <span className="gv-tl__time">{s.time}</span> : null}
              <span className="gv-tl__mark" aria-hidden={numbered ? undefined : "true"}>
                {numbered ? <span className="gv-tl__num">{n}</span> : <span className="gv-tl__dot" />}
              </span>
              <span className="gv-tl__body">
                <span className="gv-tl__title">{s.title}</span>
                {s.note ? <span className="gv-tl__note">{s.note}</span> : null}
              </span>
              {s.meta ? <span className="gv-tl__meta">{s.meta}</span> : <span />}
            </button>
            {s.leg && i < stops.length - 1 ? (
              <div className="gv-tl__leg">
                <span className="gv-tl__legline" aria-hidden="true" />
                <span>{s.leg}</span>
              </div>
            ) : i < stops.length - 1 ? (
              <div className="gv-tl__gap" aria-hidden="true">
                <span className="gv-tl__legline" />
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
