// The typed control primitives the inspector renders per config field. THE RULE:
// every enum / closed-set field is a selector (Select dropdown or Segmented chips)
// — never a free string. Only genuinely free values use Text / Textarea / Tags /
// BindingRef. All reuse the existing design-system primitives (.sp-chip,
// .wfe-field, the model-picker select look) so the inspector matches the app.
import { useState } from "react";

// A labeled field wrapper — uppercase-ish dim label + the control + optional
// help/warn/error. `error` is a hard validation failure (red); `warn` is an
// advisory flag (amber) that doesn't block the commit. Error wins the slot.
export function Field({ label, required, help, error, warn, children }) {
  return (
    <label className="wfe-field">
      <span className="wfe-field__label">{label}{required ? " *" : ""}</span>
      {children}
      {help && !error && !warn && <span className="wfe-field__help">{help}</span>}
      {error && <span className="wfe-field__err">{error}</span>}
      {!error && warn && <span className="wfe-field__warn">{warn}</span>}
    </label>
  );
}

// Normalize options to [{ value, label }]. Accepts strings or objects.
function asOptions(options) {
  return (options || []).map((o) => (typeof o === "string" ? { value: o, label: o } : o));
}

// Dropdown selector for a (often catalog-backed) closed set. `placeholder` is the
// empty/optional choice; omit `allowEmpty` to force a pick.
export function Select({ value, options, onChange, placeholder = "— none —", allowEmpty = true }) {
  const opts = asOptions(options);
  return (
    <select
      className="wfe-select"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
    >
      {allowEmpty && <option value="">{placeholder}</option>}
      {opts.map((o) => (
        <option key={o.value} value={o.value}>{o.label}{o.tag ? ` · ${o.tag}` : ""}</option>
      ))}
    </select>
  );
}

// Segmented chip row for a short enum (effort, predicate op, loop strategy). The
// `on` chip is the selected value; clicking a chip selects it (optionally toggles
// back to undefined when `clearable`).
export function Segmented({ value, options, onChange, clearable = false }) {
  const opts = asOptions(options);
  if (opts.length === 0) return <span className="wfe-field__help">no options for the selected model</span>;
  return (
    <div className="sp-chips wfe-seg">
      {opts.map((o) => {
        const on = value === o.value;
        return (
          <button
            type="button"
            key={o.value}
            className={"sp-chip sp-chip--toggle" + (on ? " on" : "")}
            onClick={() => onChange(clearable && on ? undefined : o.value)}
          >
            <span className="chip-val">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function TextInput({ value, onChange, placeholder, mono }) {
  return (
    <input
      type="text"
      className={"wfe-input" + (mono ? " wfe-input--mono" : "")}
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function TextArea({ value, onChange, placeholder, rows = 4 }) {
  return (
    <textarea
      className="wfe-textarea"
      rows={rows}
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

// A bounded integer (maxIterations / timeoutMs / loop limit). Empty ⇒ undefined.
export function NumberInput({ value, onChange, min }) {
  return (
    <input
      type="number"
      className="wfe-input wfe-input--mono"
      value={value ?? ""}
      min={min}
      onChange={(e) => {
        const t = e.target.value;
        onChange(t === "" ? undefined : Number(t));
      }}
    />
  );
}

// A string[] editor (toolsAllow/Deny, script args). Type + Enter (or comma) to add
// a tag; click a tag to remove it. Free values, but never a raw blob.
export function Tags({ value, onChange, placeholder }) {
  const [draft, setDraft] = useState("");
  const tags = Array.isArray(value) ? value : [];
  const add = () => {
    const t = draft.trim();
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setDraft("");
  };
  return (
    <div className="wfe-tags">
      <div className="wfe-tags__list">
        {tags.map((t) => (
          <button type="button" key={t} className="sp-chip wfe-tag" onClick={() => onChange(tags.filter((x) => x !== t))}>
            <span className="chip-val">{t}</span><span className="wfe-tag__x">×</span>
          </button>
        ))}
      </div>
      <input
        type="text"
        className="wfe-input"
        value={draft}
        placeholder={placeholder || "add…"}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }}
        onBlur={add}
      />
    </div>
  );
}

// A binding-ref text field with autocomplete from upstream node ids ({{nodes.*}},
// {{args}}, {{item}}). Free text (a ref is genuinely free) but suggestion-assisted.
export function BindingRef({ value, onChange, suggestions, placeholder, listId }) {
  return (
    <>
      <input
        type="text"
        className="wfe-input wfe-input--mono"
        value={value ?? ""}
        placeholder={placeholder || "{{nodes.<id>.output}}"}
        list={listId}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {(suggestions || []).map((s) => <option key={s} value={s} />)}
      </datalist>
    </>
  );
}
