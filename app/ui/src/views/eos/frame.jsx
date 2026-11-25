import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

// The shared parts of an Eos screen, drawn with eos.css's frame classes: a
// section with its label, an empty state that says what a screen is for and
// offers the one next step, a band of state across the measure, and the
// dialog Eos asks in.

// A labelled part of a screen. `aside` sits at the label's right: a count or
// a quiet link. `id` names the heading the section is labelled by.
export function Section({ id, label, aside, children }) {
  return (
    <section className="eos-section" aria-labelledby={id}>
      <div className="eos-section__head">
        <h2 id={id} className="eos-label">{label}</h2>
        {aside && <span className="eos-section__aside">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

// Nothing here yet: what this place is for, and the one thing to do next.
export function EmptyState({ title, children, action }) {
  return (
    <div className="eos-empty">
      <p className="eos-empty__title">{title}</p>
      {children && <p className="eos-empty__text">{children}</p>}
      {action && <div className="eos-actions">{action}</div>}
    </div>
  );
}

// One line of state with its tone ("warn", "err", "ok") and an action.
export function Band({ tone, role, children, action }) {
  return (
    <div className={tone ? `eos-band eos-band--${tone}` : "eos-band"} role={role}>
      <span className="eos-band__text">{children}</span>
      {action}
    </div>
  );
}

const never = () => () => {};
// True in a window, false while drawn to markup: a portal has no server form.
export const useInWindow = () => useSyncExternalStore(never, () => true, () => false);

const FOCUSABLE = "button:not([disabled]), input, textarea, select, [href], [tabindex]:not([tabindex='-1'])";

// What a key does inside a dialog whose focusable parts are `all` in order:
// "close" for Escape, the part the focus wraps to when Tab leaves an edge,
// otherwise null (the browser moves the focus as usual).
export function askKey(key, shiftKey, all, active) {
  if (key === "Escape") return "close";
  if (key !== "Tab" || !all.length) return null;
  if (active !== (shiftKey ? all[0] : all.at(-1))) return null;
  return shiftKey ? all.at(-1) : all[0];
}

// Eos's own dialog, over the whole window and outside anything an agent
// wrote: where the question comes from (`from`, a label after its `icon`
// path), the question as its title, one `line` of what follows, the
// `children`, then `actions` (Cancel first, the act last). Escape and the
// shade call `onClose`; Tab stays inside; the focus goes back to what opened
// it. Drawn into the body, so no scrolling column or container clips it.
export function Dialog({ id, from, icon, title, line, role = "dialog", onClose, actions, children, wide }) {
  const panel = useRef(null);
  const inWindow = useInWindow();
  useEffect(() => {
    const opener = document.activeElement;
    if (!panel.current?.contains(document.activeElement)) panel.current?.querySelector(FOCUSABLE)?.focus();
    return () => opener?.focus?.();
  }, []);
  const keys = (e) => {
    const all = e.key === "Tab" ? [...panel.current.querySelectorAll(FOCUSABLE)] : [];
    const step = askKey(e.key, e.shiftKey, all, document.activeElement);
    if (step === "close") {
      e.stopPropagation();
      onClose();
    } else if (step) {
      e.preventDefault();
      step.focus();
    }
  };
  const drawn = (
    <div className="eos-ask-shade" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panel} className={wide ? "eos-ask eos-ask--wide" : "eos-ask"} role={role} aria-modal="true" aria-labelledby={`${id}-title`} onKeyDown={keys}>
        {from && (
          <p className="eos-ask__from">
            {icon && <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d={icon} /></svg>}
            {from}
          </p>
        )}
        <h2 id={`${id}-title`} className="eos-ask__title">{title}</h2>
        {line && <p className="eos-ask__line">{line}</p>}
        {children}
        {actions && <div className="eos-ask__acts">{actions}</div>}
      </div>
    </div>
  );
  return inWindow ? createPortal(drawn, document.body) : drawn;
}

// Facts in a dialog, one row each on hairlines: `rows` of [label, value].
export function AskRows({ rows }) {
  return (
    <dl className="eos-ask__rows">
      {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  );
}

// One of a few things to pick in a dialog, each a row on hairlines with a
// mark that fills when picked, its name, a line under it and a mono `kind` at
// its right: `items` of { id, name, line, kind }. Arrows move the pick.
export function AskPick({ label, items, picked, onPick }) {
  const at = items.findIndex((it) => it.id === picked);
  const keys = (e) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = (Math.max(at, 0) + step + items.length) % items.length;
    onPick(items[next].id);
    e.currentTarget.querySelectorAll("[role=radio]")[next]?.focus();
  };
  return (
    <div className="eos-ask__pick" role="radiogroup" aria-label={label} onKeyDown={keys}>
      {items.map((it, i) => (
        <button
          key={it.id}
          type="button"
          role="radio"
          aria-checked={it.id === picked}
          tabIndex={i === (at < 0 ? 0 : at) ? 0 : -1}
          className="eos-ask__pick-row"
          onClick={() => onPick(it.id)}
        >
          <span className="eos-ask__pick-mark" aria-hidden="true" />
          <span className="eos-ask__pick-text">
            <span className="eos-ask__pick-name">{it.name}</span>
            {it.line && <span className="eos-ask__pick-line">{it.line}</span>}
          </span>
          {it.kind && <span className="eos-ask__pick-kind">{it.kind}</span>}
        </button>
      ))}
    </div>
  );
}

// A thing named by its glyph (a 16-viewBox path) in a 30 px ring lit in its
// tone ("active", "ok", "warn", "err").
export function Ring({ d, tone }) {
  return (
    <span className={tone ? `eos-ring eos-ring--${tone}` : "eos-ring"} aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 16 16"><path d={d} /></svg>
    </span>
  );
}

// One fact under a lead: a 13 px line after its tone's 9 px mark ("active",
// "ok", "warn", "err", "done", or none for a hollow one), then its actions.
export function Fact({ tone, role, className, children, actions }) {
  const names = ["eos-fact", tone && `eos-fact--${tone}`, className].filter(Boolean).join(" ");
  return (
    <p className={names} role={role}>
      {children}
      {actions}
    </p>
  );
}

// A screen whose read failed, said as its lead: what could not be read, that
// Eos did not answer, in the err tone, and Try again.
export function FailedLead({ what, retry }) {
  return (
    <header className="eos-rlead eos-failed" role="alert">
      <p className="eos-lead">Couldn&apos;t load {what}.</p>
      <p className="eos-rlead__now eos-rlead__now--err">Eos did not answer this time.</p>
      <div className="eos-rlead__acts"><button type="button" className="eos-btn" onClick={retry}>Try again</button></div>
    </header>
  );
}

// A hand-off of a few steps drawn as stations on one line, as a run's are:
// `names` in order, the one it is `at` lit in its `tone` with its word from
// `words` under its name (breathing while `working`), the way behind solid,
// the way ahead dashed; the line is whole once the last station is reached.
// It runs on into the gutter and fades, or stays in its box with `inset`.
export function Stations({ names, at, tone, words = [], working = false, inset = false, className }) {
  const stop = (i) => {
    if (i > at) return "eos-beat__stop eos-beat__stop--ahead";
    if (i < at) return "eos-beat__stop";
    return `eos-beat__stop eos-beat__stop--newest eos-beat__stop--${tone}${working ? " eos-beat__stop--working" : ""}`;
  };
  const classes = ["eos-beat", at === names.length - 1 && "eos-beat--ends", inset && "eos-beat--inset", className].filter(Boolean).join(" ");
  return (
    <div className={classes} aria-hidden="true">
      <ol className="eos-beat__line">
        {names.map((name, i) => (
          <li key={name} className={stop(i)}>
            <span className="eos-beat__mark">
              <span className="eos-beat__dot" />
              <span className="eos-beat__tag">{name}</span>
              <span className={i === at ? `eos-beat__word eos-beat__word--${tone}` : "eos-beat__word"}>{words[i] || "\u00a0"}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
