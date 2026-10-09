import { useView } from "../../runtime/ViewContext.jsx";
import { attrNum, attrText } from "../../../../../../contracts/src/genui/attrs.ts";
import { hasTemplate } from "../../../../../../contracts/src/genui/expr.ts";
import { formatNumber, withUnit } from "./format.js";
import { applyLens, getPath, isTone, itemId, itemName, looseNumber, sameId, toneHex } from "./util.js";
import { FilterEmpty } from "../inputs/FilterEmpty.jsx";

// The scale a bar fills against: max= when given; for a set of bars, the
// largest; for one bar, the nearest of 1 / 5 / 10 / 100 that holds it.
export function meterMax(values, max) {
  if (max != null && Number.isFinite(max) && max > 0) return max;
  const nums = values.filter((v) => Number.isFinite(v));
  const top = nums.length ? Math.max(...nums) : 0;
  if (values.length > 1) return top > 0 ? top : 1;
  if (top <= 1) return 1;
  if (top <= 5) return 5;
  if (top <= 10) return 10;
  return top <= 100 ? 100 : top;
}

function MeterRow({ label, value, max, unit, onSelect, selected }) {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const text = value == null ? "—" : withUnit(formatNumber(value), unit);
  const Tag = onSelect ? "button" : "div";
  return (
    <Tag
      type={onSelect ? "button" : undefined}
      className={`gv-meter__row${selected ? " is-selected" : ""}`}
      onClick={onSelect}
      aria-pressed={onSelect ? Boolean(selected) : undefined}
    >
      <span className="gv-meter__label" title={label}>
        {label}
      </span>
      <span className="gv-meter__track" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value ?? 0} aria-label={label || undefined}>
        <span className="gv-meter__fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="gv-meter__value">{text}</span>
    </Tag>
  );
}

export function Meter({ attrs = {} }) {
  const view = useView();
  // Bars default to the Eos accent (the boards draw them blue in any view
  // tone); tone= picks another.
  const style = isTone(attrs.tone) ? { "--gv-meter-fill": toneHex(attrs.tone) } : undefined;
  const unit = attrText(attrs.unit);
  const maxAttr = attrNum(attrs.max);
  if (typeof attrs.of === "string") {
    const of = attrs.of;
    const items = applyLens(view.collection(of), attrs, view.state);
    if (!items.length) return <FilterEmpty of={of} />;
    const field = attrText(attrs.value);
    const constant = attrNum(attrs.value);
    const values = items.map((it) => {
      if (hasTemplate(field)) return looseNumber(view.template(field, it));
      if (constant != null) return constant;
      return looseNumber(getPath(it, field));
    });
    const max = meterMax(values, maxAttr);
    const sel = view.selected(of);
    return (
      <div className="gv-meter gv-meter--set" style={style}>
        {items.map((it, i) => {
          const id = it && it.id != null ? itemId(it, i) : null;
          return (
            <MeterRow
              key={id ?? i}
              label={attrs.label !== undefined ? view.template(attrText(attrs.label), it) : itemName(it)}
              value={values[i]}
              max={max}
              unit={unit}
              selected={id != null && sameId(sel, id)}
              onSelect={id != null ? () => view.select(of, id) : undefined}
            />
          );
        })}
      </div>
    );
  }
  const raw = attrNum(attrs.value) ?? looseNumber(view.template(attrText(attrs.value), undefined));
  const max = meterMax([raw ?? 0], maxAttr);
  return (
    <div className="gv-meter" style={style}>
      <MeterRow label={view.template(attrText(attrs.label), undefined)} value={raw} max={max} unit={unit} />
    </div>
  );
}
