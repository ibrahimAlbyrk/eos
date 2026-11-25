// The shared parts of an Eos screen, drawn with eos.css's frame classes: a
// section with its label, an empty state that says what a screen is for and
// offers the one next step, and a band of state across the measure.

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
