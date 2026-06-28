// The Form | JSON hybrid wrapper shared by the schema + args row builders. It owns
// the per-field mode toggle and the round-trip discipline:
//   • a REPRESENTABLE value defaults to the structured Form (the row builder);
//   • an ADVANCED value (nested object, array-of-objects, oneOf/$ref, …) is pinned
//     to the raw JSON editor with a note saying WHY, so Form mode never clobbers
//     data the rows can't carry.
// JSON mode is the existing JsonField (step-1 validation intact); Form mode renders
// the supplied row builder. Reselecting a node/field resets the mode to the new
// value's representability (the value itself is preserved — it lives in config).
import { useEffect, useRef, useState } from "react";
import { Field, Segmented } from "./inspectorControls.jsx";
import { JsonField } from "./JsonField.jsx";

const TOGGLE = [{ value: "form", label: "Form" }, { value: "json", label: "JSON" }];

// Stable serialization for the external-vs-self change guard (a JsonField parse or
// a row edit may hand back a fresh object that is value-equal to what we emitted).
const stable = (v) => (v === undefined ? "" : JSON.stringify(v));

export function HybridField({ label, required, help, value, onChange, jsonMode, validator, isRepresentable, describeRaw, renderForm }) {
  const representable = isRepresentable(value);
  const reason = representable ? null : describeRaw(value);
  const [mode, setMode] = useState(representable ? "form" : "json");
  const lastSeen = useRef(stable(value));

  // Only an EXTERNAL value change (reselect/undo) resets the mode — a self edit
  // hands back a value-equal payload, so it doesn't kick the operator out of the
  // mode they're in.
  useEffect(() => {
    const s = stable(value);
    if (s !== lastSeen.current) {
      lastSeen.current = s;
      setMode(isRepresentable(value) ? "form" : "json");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const emit = (v) => {
    lastSeen.current = stable(v);
    onChange(v);
  };

  const effectiveMode = representable ? mode : "json";

  if (effectiveMode === "json") {
    return (
      <div className="wfe-hybrid">
        <div className="wfe-hybrid__bar">
          {representable ? (
            <Segmented value="json" options={TOGGLE} onChange={setMode} />
          ) : (
            <span className="wfe-hybrid__locked">Form unavailable</span>
          )}
        </div>
        {!representable && reason && <div className="wfe-field__help wfe-hybrid__reason">Advanced JSON — {reason}</div>}
        <JsonField label={label} required={required} value={value} mode={jsonMode} help={help} onChange={emit} validator={validator} />
      </div>
    );
  }

  const warn = validator && value !== undefined ? validator(value) : null;
  return (
    <div className="wfe-hybrid">
      <div className="wfe-hybrid__bar">
        <Segmented value="form" options={TOGGLE} onChange={setMode} />
      </div>
      <Field label={label} required={required} help={help} warn={warn}>
        {renderForm({ value, onChange: emit })}
      </Field>
    </div>
  );
}
