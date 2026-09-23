import { useEffect, useState, useRef } from "react";

export function OptionIcon({ type }) {
  if (type === "draft") return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="8" cy="4" r="1.5" /><circle cx="8" cy="12" r="1.5" />
      <line x1="8" y1="5.5" x2="8" y2="10.5" strokeDasharray="2 2" />
    </svg>
  );
  if (type === "external") return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M6 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2" />
      <path d="M9 2h5v5M14 2 7 9" />
    </svg>
  );
  if (type === "commit") return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="8" cy="8" r="2.5" />
      <line x1="1.5" y1="8" x2="5.5" y2="8" /><line x1="10.5" y1="8" x2="14.5" y2="8" />
    </svg>
  );
  if (type === "push") return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 13V5M5 8l3-3 3 3" />
      <line x1="4" y1="2.5" x2="12" y2="2.5" />
    </svg>
  );
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="5" cy="4" r="1.5" /><circle cx="5" cy="12" r="1.5" /><circle cx="11" cy="8" r="1.5" />
      <path d="M5 5.5v5M6.5 8h3" />
    </svg>
  );
}

// Main action + caret that picks which action the main button runs.
// onOpenChange lets the host keep itself expanded while the menu is up.
export function SplitButton({ options, mode, onSelectMode, onAction, onOpenChange, disabled, title }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    onOpenChange?.(true);
    return () => onOpenChange?.(false);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const active = options.find((o) => o.id === mode) ?? options[0];

  return (
    <div className="pr-wrap" ref={ref}>
      {open && (
        <div className="pr-menu">
          {options.map((opt) => (
            <button key={opt.id} className={"pr-menu-item" + (mode === opt.id ? " on" : "")} onClick={() => { onSelectMode(opt.id); setOpen(false); }}>
              <OptionIcon type={opt.icon} />
              <span>{opt.label}</span>
              {mode === opt.id && (
                <svg className="pr-menu-check" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m3 8 3 3 7-7" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
      <button className="pr-create-btn" disabled={disabled} title={title ?? active.label} onClick={() => onAction(active.id)}>
        <span className="split-ic"><OptionIcon type={active.icon} /></span>
        <span className="btn-label">{active.label}</span>
      </button>
      <button className="pr-dropdown-toggle" disabled={disabled} onClick={() => setOpen(!open)}>
        <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
    </div>
  );
}
