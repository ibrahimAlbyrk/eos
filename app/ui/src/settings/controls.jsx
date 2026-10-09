// Control renderers keyed by `control.type` from the settings registry.
// Every control receives { value, onChange } plus the rest of its registry
// `control` props. Adding a control type = one component + one CONTROLS entry.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Fixed-position popover rendered in a body portal so it escapes the settings
// modal's overflow:hidden + scrolling body, which otherwise clip a menu opening
// near the bottom edge (the reported "half-cut dropdown"). Anchored to
// `anchorRef`, flips above when there's no room below, and owns outside-click
// close — the menu lives outside the control's DOM subtree, so the control can't
// detect inside-clicks (a mousedown on an option would read as "outside" and
// unmount it before its click fires).
function AnchoredPopover({ anchorRef, open, onClose, align = "left", matchWidth = false, className, children }) {
  const popRef = useRef(null);
  const [style, setStyle] = useState(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      if (!a) return;
      const gap = 6;
      const h = popRef.current?.offsetHeight ?? 0;
      const below = window.innerHeight - a.bottom;
      const flipUp = below < h + gap && a.top > below;
      const next = { position: "fixed", top: flipUp ? a.top - gap - h : a.bottom + gap };
      if (align === "right") next.right = window.innerWidth - a.right;
      else next.left = a.left;
      if (matchWidth) next.minWidth = a.width;
      setStyle(next);
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, anchorRef, align, matchWidth]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (anchorRef.current?.contains(e.target)) return;
      if (popRef.current?.contains(e.target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open, anchorRef, onClose]);

  if (!open) return null;
  return createPortal(
    <div ref={popRef} className={className} style={style ?? { position: "fixed", visibility: "hidden" }}>
      {children}
    </div>,
    document.body,
  );
}

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

// Segmented control — options: [{ value, label, Icon? }]. With an Icon the label
// becomes the tooltip; without one the segment shows the label as text. The
// active segment gets a raised glass pill.
function SegmentedControl({ value, onChange, options }) {
  return (
    <div className="stg-seg" role="radiogroup">
      {(options ?? []).map((o) => (
        <button
          type="button"
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          title={o.Icon ? o.label : undefined}
          className={`stg-seg__btn${o.Icon ? "" : " stg-seg__btn--text"}${value === o.value ? " is-active" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.Icon ? <o.Icon /> : o.label}
        </button>
      ))}
    </div>
  );
}

// Pill choices — options: [{ value, label }]. `multiple`: value is an array and
// each pill toggles; otherwise value is one option or null, and picking the
// selected pill again clears it (an unset preference, not a forced default).
function ChipsControl({ value, onChange, options, multiple = false }) {
  const picked = multiple ? (Array.isArray(value) ? value : []) : [value];
  const toggle = (v) => {
    if (!multiple) return onChange(value === v ? null : v);
    onChange(picked.includes(v) ? picked.filter((x) => x !== v) : [...picked, v]);
  };
  return (
    <div className="stg-chips" role={multiple ? "group" : "radiogroup"}>
      {(options ?? []).map((o) => {
        const on = picked.includes(o.value);
        return (
          <button
            type="button"
            key={o.value}
            role={multiple ? "checkbox" : "radio"}
            aria-checked={on}
            className={`stg-chip${on ? " is-on" : ""}`}
            onClick={() => toggle(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// Free-text tags — Enter or comma adds, × removes, Backspace on an empty draft
// drops the last one. Duplicates (any case) are ignored.
function TagsControl({ value, onChange, placeholder = "Add…", max = 40 }) {
  const tags = Array.isArray(value) ? value : [];
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim().replace(/,$/, "").trim();
    setDraft("");
    if (!t || tags.length >= max || tags.some((x) => x.toLowerCase() === t.toLowerCase())) return;
    onChange([...tags, t]);
  };
  return (
    <div className="stg-toolpick stg-tags">
      {tags.map((t) => (
        <span className="stg-toolpick__chip" key={t}>
          {t}
          <button type="button" className="stg-toolpick__rm" aria-label={`Remove ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>
            <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </span>
      ))}
      <input
        className="stg-tags__input"
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
          else if (e.key === "Backspace" && !draft && tags.length) onChange(tags.slice(0, -1));
        }}
      />
    </div>
  );
}

// Multi-line text committing on blur, like TextControl (every change is a PUT).
function TextareaControl({ value, onChange, placeholder, rows = 6, maxLength }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => { setDraft(value ?? ""); }, [value]);
  return (
    <textarea
      className="stg-textarea"
      value={draft}
      rows={rows}
      maxLength={maxLength}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== (value ?? "")) onChange(draft); }}
    />
  );
}

// Custom dropdown (not a native <select>) so the open menu matches the
// liquid-glass popover language. Same capture-phase outside-close as
// ToolPickerControl below. Options may carry `disabled` (listed but not
// pickable — e.g. providers that aren't wired yet) and `hint` (small badge).
export function SelectControl({ value, onChange, options }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const current = (options ?? []).find((o) => o.value === value);

  return (
    <div className="stg-dd">
      <button ref={btnRef} type="button" className={`stg-dd__btn${open ? " is-open" : ""}`} onClick={() => setOpen((v) => !v)}>
        <span>{current?.label ?? String(value ?? "")}</span>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      <AnchoredPopover anchorRef={btnRef} open={open} onClose={() => setOpen(false)} align="right" matchWidth className="stg-dd__menu glass-pop">
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
      </AnchoredPopover>
    </div>
  );
}

// Multi-select tool list: chips for the chosen tools, a "+" button opening a
// popover of the remaining `tools` (registry control props). Value is a
// string array, replaced wholesale on every change (one settings key).
function ToolPickerControl({ value, onChange, tools }) {
  const selected = Array.isArray(value) ? value : [];
  const [open, setOpen] = useState(false);
  const addRef = useRef(null);
  const available = (tools ?? []).filter((t) => !selected.includes(t));

  return (
    <div className="stg-toolpick">
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
          <button ref={addRef} className="stg-toolpick__add" title="Add tool" onClick={() => setOpen((v) => !v)}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
          <AnchoredPopover anchorRef={addRef} open={open} onClose={() => setOpen(false)} className="stg-toolpick__menu glass-pop">
            <div className="stg-toolpick__list">
              {available.map((t) => (
                <button key={t} className="stg-toolpick__opt" onClick={() => onChange([...selected, t])}>
                  {t}
                </button>
              ))}
            </div>
          </AnchoredPopover>
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

// Range slider for a bounded number. The label shows the draft while dragging;
// the value commits once on release (every change is a PUT to the daemon).
// `format` renders the value (e.g. a ratio as "70%").
function SliderControl({ value, onChange, min, max, step, format = String }) {
  const [draft, setDraft] = useState(value ?? min);
  useEffect(() => { setDraft(value ?? min); }, [value, min]);
  const commit = () => { if (draft !== value) onChange(draft); };
  const fill = ((draft - min) / (max - min)) * 100;
  return (
    <div className="stg-slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft}
        style={{ "--fill": `${fill}%` }}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="stg-slider__value">{format(draft)}</span>
    </div>
  );
}

// A row that brings its own UI: control: { type: "custom", Component }.
function CustomControl({ Component, value, onChange }) {
  return Component ? <Component value={value} onChange={onChange} /> : null;
}

export const CONTROLS = {
  custom: CustomControl,
  toggle: ToggleControl,
  slider: SliderControl,
  select: SelectControl,
  segmented: SegmentedControl,
  chips: ChipsControl,
  toolPicker: ToolPickerControl,
  tags: TagsControl,
  text: TextControl,
  textarea: TextareaControl,
};
