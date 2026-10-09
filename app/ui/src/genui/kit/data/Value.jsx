import { useView } from "../../runtime/ViewContext.jsx";
import { attrText } from "../../../../../../contracts/src/genui/attrs.ts";
import { formatNumber } from "./format.js";
import { isTone, toneStyle } from "./util.js";

const NUMERIC = /^\s*-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/;

// The text a computed value shows: numbers through Intl (format/decimals/
// currency), text as written, nothing computable → an em dash.
export function valueText(v, opts = {}) {
  const { prefix = "", suffix = "" } = opts;
  if (Array.isArray(v)) return v.map((x) => valueText(x, { ...opts, prefix: "", suffix: "" })).join(", ") || "—";
  if (typeof v === "number") return Number.isFinite(v) ? formatNumber(v, { ...opts, format: opts.format || "number" }) : "—";
  if (typeof v === "string") {
    if (NUMERIC.test(v)) return formatNumber(Number(v), { ...opts, format: opts.format || "number" });
    return v ? `${prefix}${v}${suffix}` : "—";
  }
  if (typeof v === "boolean") return String(v);
  return "—";
}

export function Value({ attrs = {} }) {
  const view = useView();
  const fill = (v) => view.template(attrText(v), undefined);
  const raw = view.evalExpr(attrText(attrs.expr));
  const text = valueText(raw, {
    format: attrText(attrs.format),
    decimals: attrs.decimals,
    currency: attrText(attrs.currency) || undefined,
    prefix: fill(attrs.prefix),
    suffix: fill(attrs.suffix),
  });
  const label = fill(attrs.label);
  const tone = isTone(attrs.tone) ? attrs.tone.toLowerCase() : null;
  const size = ["sm", "md", "lg"].includes(attrs.size) ? attrs.size : "md";
  return (
    <div className={`gv-value gv-value--${size}${tone ? " gv-value--toned" : ""}`} style={toneStyle(tone)}>
      {label ? <div className="gv-value__label">{label}</div> : null}
      <div className="gv-value__num" aria-live="polite">
        {text}
      </div>
    </div>
  );
}
