// Control renderers keyed by `control.type` from the settings registry.
// Every control receives { value, onChange } plus the rest of its registry
// `control` props. Adding a control type = one component + one CONTROLS entry.

import { useEffect, useRef, useState } from "react";

function ToggleControl({ value, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!value}
      className={`stg-toggle${value ? " is-on" : ""}`}
      onClick={() => onChange(!value)}
    >
      <span className="stg-toggle__knob" />
    </button>
  );
}

// Icon segmented control — options: [{ value, label, Icon }]. Label becomes
// the tooltip; the active segment gets a raised glass pill.
function SegmentedControl({ value, onChange, options }) {
  return (
    <div className="stg-seg" role="radiogroup">
      {(options ?? []).map((o) => (
        <button
          type="button"
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          title={o.label}
          className={`stg-seg__btn${value === o.value ? " is-active" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.Icon ? <o.Icon /> : o.label}
        </button>
      ))}
    </div>
  );
}

// Custom dropdown (not a native <select>) so the open menu matches the
// liquid-glass popover language. Same capture-phase outside-close as
// ToolPickerControl below. Options may carry `disabled` (listed but not
// pickable — e.g. providers that aren't wired yet) and `hint` (small badge).
function SelectControl({ value, onChange, options }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const current = (options ?? []).find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);

  return (
    <div className="stg-dd" ref={wrapRef}>
      <button type="button" className={`stg-dd__btn${open ? " is-open" : ""}`} onClick={() => setOpen((v) => !v)}>
        <span>{current?.label ?? String(value ?? "")}</span>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className="stg-dd__menu glass-pop">
          <div className="stg-dd__list">
            {(options ?? []).map((o) => (
              <button
                type="button"
                key={o.value}
                disabled={o.disabled}
                className={`stg-dd__opt${o.value === value ? " is-active" : ""}${o.disabled ? " is-disabled" : ""}`}
                onClick={() => { if (o.disabled) return; onChange(o.value); setOpen(false); }}
              >
                <span>{o.label}</span>
                {o.hint && <span className="stg-dd__hint">{o.hint}</span>}
                {o.value === value && (
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 8.5l3.5 3.5L13 5" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Multi-select tool list: chips for the chosen tools, a "+" button opening a
// popover of the remaining `tools` (registry control props). Value is a
// string array, replaced wholesale on every change (one settings key).
function ToolPickerControl({ value, onChange, tools }) {
  const selected = Array.isArray(value) ? value : [];
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const available = (tools ?? []).filter((t) => !selected.includes(t));

  // Capture phase — the settings modal stops mousedown propagation (for its
  // backdrop-close), so a bubble listener would never see inside-modal clicks.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);

  return (
    <div className="stg-toolpick" ref={wrapRef}>
      {selected.map((t) => (
        <span className="stg-toolpick__chip" key={t}>
          {t}
          <button
            className="stg-toolpick__rm"
            title={`Remove ${t}`}
            onClick={() => onChange(selected.filter((x) => x !== t))}
          >
            <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </span>
      ))}
      {selected.length === 0 && <span className="stg-toolpick__empty">No tools selected</span>}
      {available.length > 0 && (
        <div className="stg-toolpick__addwrap">
          <button className="stg-toolpick__add" title="Add tool" onClick={() => setOpen((v) => !v)}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
          {open && (
            <div className="stg-toolpick__menu glass-pop">
              <div className="stg-toolpick__list">
                {available.map((t) => (
                  <button key={t} className="stg-toolpick__opt" onClick={() => onChange([...selected, t])}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const EyeIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const EyeOffIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="3" />
    <path d="M4 4l16 16" />
  </svg>
);

// Text input committing on blur/Enter, not per keystroke (every change is a
// PATCH to the daemon). `secret` masks the value at rest (API keys) with an
// eye button toggling it readable.
function TextControl({ value, onChange, placeholder, secret }) {
  const [draft, setDraft] = useState(value ?? "");
  const [revealed, setRevealed] = useState(false);
  useEffect(() => { setDraft(value ?? ""); }, [value]);
  const commit = () => { if (draft !== (value ?? "")) onChange(draft); };
  return (
    <div className="stg-input">
      <input
        type={secret && !revealed ? "password" : "text"}
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="new-password"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
      />
      {secret && (
        <button
          type="button"
          className="stg-input__eye"
          title={revealed ? "Hide" : "Show"}
          onClick={() => setRevealed((v) => !v)}
        >
          {revealed ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      )}
    </div>
  );
}

export const CONTROLS = {
  toggle: ToggleControl,
  select: SelectControl,
  segmented: SegmentedControl,
  toolPicker: ToolPickerControl,
  text: TextControl,
};
