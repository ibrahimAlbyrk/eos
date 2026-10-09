import { useView } from "../../runtime/ViewContext.jsx";
import { attrNum, attrText } from "../../../../../../contracts/src/genui/attrs.ts";
import { formatNumber } from "./format.js";
import { isTone, looseNumber, toneStyle } from "./util.js";

// {fraction 0–1, text}. With max=: value/max ("3 / 4"); without, a value ≤ 1 is
// a fraction and anything larger a percent.
export function progressOf(value, max) {
  const v = typeof value === "number" ? value : looseNumber(value);
  if (v == null || !Number.isFinite(v)) return { fraction: 0, text: "—" };
  const m = max != null && Number.isFinite(max) && max > 0 ? max : null;
  let fraction;
  let text;
  if (m != null) {
    fraction = v / m;
    text = Number.isInteger(v) && Number.isInteger(m) ? `${formatNumber(v, { format: "int" })} / ${formatNumber(m, { format: "int" })}` : formatNumber(fraction, { format: "percent", decimals: 0 });
  } else {
    fraction = v <= 1 ? v : v / 100;
    text = formatNumber(fraction, { format: "percent", decimals: 0 });
  }
  return { fraction: Math.max(0, Math.min(1, fraction)), text };
}

export function Progress({ attrs = {} }) {
  const view = useView();
  const raw = attrs.expr !== undefined ? view.evalExpr(attrText(attrs.expr)) : attrNum(attrs.value) ?? looseNumber(view.template(attrText(attrs.value), undefined));
  const { fraction, text } = progressOf(Array.isArray(raw) ? raw.length : raw, attrNum(attrs.max));
  const label = view.template(attrText(attrs.label), undefined);
  const tone = isTone(attrs.tone) ? attrs.tone.toLowerCase() : null;
  const pct = Math.round(fraction * 100);
  return (
    <div className="gv-progress" style={toneStyle(tone)}>
      <div className="gv-progress__head">
        {label ? <span className="gv-progress__label">{label}</span> : null}
        <span className="gv-progress__value">{text}</span>
      </div>
      <div className="gv-progress__track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label || undefined}>
        <span className="gv-progress__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
