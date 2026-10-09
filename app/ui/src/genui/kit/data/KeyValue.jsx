import { useView } from "../../runtime/ViewContext.jsx";
import { attrNum, attrText } from "../../../../../../contracts/src/genui/attrs.ts";
import { applyLens, getPath, itemName } from "./util.js";

function scalar(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(scalar).filter(Boolean).join(", ");
  if (typeof v === "object") return scalar(v.text ?? v.name ?? v.title ?? v.value ?? "");
  return "";
}

// items={"Battery":"18 h"} · items={[["Battery","18 h"]]} · items={[{"label":"Battery","value":"18 h"}]}
export function itemsRows(items) {
  if (Array.isArray(items)) {
    return items
      .map((x) => {
        if (Array.isArray(x)) return { key: scalar(x[0]), value: scalar(x[1]) };
        if (x && typeof x === "object") return { key: scalar(x.label ?? x.key ?? x.name), value: scalar(x.value) };
        return null;
      })
      .filter((r) => r && r.key);
  }
  if (items && typeof items === "object") return Object.entries(items).map(([key, value]) => ({ key, value: scalar(value) }));
  return [];
}

export function KeyValue({ attrs = {} }) {
  const view = useView();
  let rows;
  if (typeof attrs.of === "string") {
    const list = applyLens(view.collection(attrs.of), attrs, view.state);
    rows = list.map((it) => ({
      key: attrs.key !== undefined ? view.template(attrText(attrs.key), it) : scalar(it.label ?? it.key) || itemName(it),
      value: attrs.value !== undefined ? view.template(attrText(attrs.value), it) : scalar(getPath(it, "value")),
    }));
  } else {
    rows = itemsRows(attrs.items).map((r) => ({ key: view.template(r.key, undefined), value: view.template(r.value, undefined) }));
  }
  const cols = attrNum(attrs.cols) === 2 ? 2 : 1;
  if (!rows.length) return null;
  return (
    <dl className={`gv-kv${cols === 2 ? " gv-kv--2" : ""}`}>
      {rows.map((r, i) => (
        <div className="gv-kv__row" key={`${r.key}-${i}`}>
          <dt className="gv-kv__key">{r.key}</dt>
          <dd className="gv-kv__value">{r.value || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}
