// Segmented · Toggle · Slider · Stepper · Select · Field — controls bound to a
// view state key (bind=). The runtime seeds each key's default, so getState's
// fallback here only matters while a view is still streaming in.

import { useId } from "react";
import { useView } from "../../runtime/ViewContext.jsx";
import { attrBool, attrNum, attrText, parseOptions } from "../../../../../../contracts/src/genui/attrs.ts";
import { SegmentedBar } from "../layout/layout.jsx";
import { formatNumber } from "../data/format.js";

function bindOf(attrs) {
  return typeof attrs.bind === "string" && attrs.bind ? attrs.bind : null;
}

// The option a stored value (or default=) points at: by value, else by label.
export function optionIndex(options, value) {
  if (value == null) return -1;
  const s = String(value);
  const byValue = options.findIndex((o) => o.value === s);
  return byValue >= 0 ? byValue : options.findIndex((o) => o.label === s);
}

function initialOption(options, dflt) {
  const i = optionIndex(options, dflt === undefined ? null : attrText(dflt));
  return options[i >= 0 ? i : 0]?.value;
}

export function Segmented({ attrs = {} }) {
  const view = useView();
  const bind = bindOf(attrs);
  const options = parseOptions(attrs.options);
  if (!bind || !options.length) return null;
  const current = view.getState(bind, initialOption(options, attrs.default));
  const index = Math.max(0, optionIndex(options, current));
  return (
    <div className="gv-segmented">
      <SegmentedBar
        labels={options.map((o) => o.label)}
        index={index}
        role="group"
        ariaLabel={options.map((o) => o.label).join(" / ")}
        onPick={(i) => view.setState(bind, options[i].value)}
      />
    </div>
  );
}

export function Toggle({ attrs = {} }) {
  const view = useView();
  const bind = bindOf(attrs);
  if (!bind) return null;
  const on = attrBool(view.getState(bind, attrBool(attrs.default, false)), false);
  const label = view.template(attrText(attrs.label), undefined);
  return (
    <label className="gv-toggle">
      <span className="gv-toggle__label">{label}</span>
      <input type="checkbox" role="switch" className="gv-switch" checked={on} aria-label={label || bind} onChange={(e) => view.setState(bind, e.target.checked)} />
    </label>
  );
}

// Snap to the slider's step grid, inside [min, max].
export function snap(value, min, max, step) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  let v = Number.isFinite(value) ? value : lo;
  if (step > 0) v = lo + Math.round((v - lo) / step) * step;
  v = Math.max(lo, Math.min(hi, v));
  return Number(v.toFixed(10));
}

export function Slider({ attrs = {} }) {
  const view = useView();
  const id = useId();
  const bind = bindOf(attrs);
  const min = attrNum(attrs.min, 0);
  const max = attrNum(attrs.max, 100);
  if (!bind) return null;
  const step = attrNum(attrs.step) ?? (Math.abs(max - min) <= 1 ? 0.01 : 1);
  const value = snap(attrNum(view.getState(bind, attrNum(attrs.default, min)), min), min, max, step);
  const label = view.template(attrText(attrs.label), undefined);
  const shown = formatNumber(value, {
    format: attrText(attrs.format) || "number",
    prefix: view.template(attrText(attrs.prefix), undefined),
    suffix: view.template(attrText(attrs.suffix), undefined),
  });
  return (
    <div className="gv-slider">
      <div className="gv-slider__head">
        {label ? <label htmlFor={id}>{label}</label> : <span />}
        <output htmlFor={id} className="gv-slider__value">
          {shown}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label || bind}
        aria-valuetext={shown}
        onChange={(e) => view.setState(bind, snap(Number(e.target.value), min, max, step))}
      />
    </div>
  );
}

export function Stepper({ attrs = {} }) {
  const view = useView();
  const bind = bindOf(attrs);
  if (!bind) return null;
  const min = attrNum(attrs.min);
  const max = attrNum(attrs.max);
  const step = attrNum(attrs.step) ?? 1;
  const clampV = (v) => Math.max(min ?? -Infinity, Math.min(max ?? Infinity, Number(v.toFixed(10))));
  const value = clampV(attrNum(view.getState(bind, attrNum(attrs.default, min ?? 0)), min ?? 0));
  const label = view.template(attrText(attrs.label), undefined);
  const unit = view.template(attrText(attrs.unit), undefined);
  const set = (v) => view.setState(bind, clampV(v));
  const atMin = min != null && value <= min;
  const atMax = max != null && value >= max;
  const onKey = (e) => {
    if (e.key === "ArrowUp" || e.key === "ArrowRight") {
      e.preventDefault();
      if (!atMax) set(value + step);
    } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
      e.preventDefault();
      if (!atMin) set(value - step);
    } else if (e.key === "Home" && min != null) {
      e.preventDefault();
      set(min);
    } else if (e.key === "End" && max != null) {
      e.preventDefault();
      set(max);
    }
  };
  return (
    <div className="gv-stepper">
      {label ? <span className="gv-stepper__label">{label}</span> : null}
      <div className="gv-stepper__ctl">
        <button type="button" className="gv-stepper__btn" aria-label={`Decrease ${label || bind}`} disabled={atMin} onClick={() => set(value - step)}>
          −
        </button>
        <span
          className="gv-stepper__value"
          role="spinbutton"
          tabIndex={0}
          aria-label={label || bind}
          aria-valuenow={value}
          aria-valuemin={min ?? undefined}
          aria-valuemax={max ?? undefined}
          aria-valuetext={unit ? `${formatNumber(value)} ${unit}` : undefined}
          onKeyDown={onKey}
        >
          {formatNumber(value)}
          {unit ? <span className="gv-stepper__unit">{unit}</span> : null}
        </span>
        <button type="button" className="gv-stepper__btn" aria-label={`Increase ${label || bind}`} disabled={atMax} onClick={() => set(value + step)}>
          +
        </button>
      </div>
    </div>
  );
}

export function Select({ attrs = {} }) {
  const view = useView();
  const id = useId();
  const bind = bindOf(attrs);
  const options = parseOptions(attrs.options);
  if (!bind || !options.length) return null;
  const current = view.getState(bind, initialOption(options, attrs.default));
  const index = Math.max(0, optionIndex(options, current));
  const label = view.template(attrText(attrs.label), undefined);
  return (
    <div className="gv-field">
      {label ? <label htmlFor={id}>{label}</label> : null}
      <select
        id={id}
        className="gv-field__control gv-field__select"
        value={String(index)}
        aria-label={label ? undefined : bind}
        onChange={(e) => view.setState(bind, options[Number(e.target.value)]?.value)}
      >
        {options.map((o, i) => (
          <option key={i} value={String(i)}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

const FIELD_TYPES = new Set(["text", "number", "date", "time", "multiline"]);

export function Field({ attrs = {} }) {
  const view = useView();
  const id = useId();
  const bind = bindOf(attrs);
  if (!bind) return null;
  const type = FIELD_TYPES.has(attrs.type) ? attrs.type : "text";
  const raw = view.getState(bind, attrText(attrs.default));
  const value = raw == null ? "" : String(raw);
  const label = view.template(attrText(attrs.label), undefined);
  const placeholder = view.template(attrText(attrs.placeholder), undefined) || undefined;
  const onChange = (e) => {
    const v = e.target.value;
    if (type === "number") view.setState(bind, v === "" ? "" : Number.isFinite(Number(v)) ? Number(v) : v);
    else view.setState(bind, v);
  };
  return (
    <div className="gv-field">
      {label ? <label htmlFor={id}>{label}</label> : null}
      {type === "multiline" ? (
        <textarea id={id} className="gv-field__control gv-field__area" value={value} placeholder={placeholder} aria-label={label ? undefined : bind} rows={3} onChange={onChange} />
      ) : (
        <input
          id={id}
          className="gv-field__control"
          type={type}
          inputMode={type === "number" ? "decimal" : undefined}
          value={value}
          placeholder={placeholder}
          aria-label={label ? undefined : bind}
          onChange={onChange}
        />
      )}
    </div>
  );
}
