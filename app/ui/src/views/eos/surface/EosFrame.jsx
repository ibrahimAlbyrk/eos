// The strip above anything a routine generated (08 §4.11): who made it and how
// much it can do. Everything that sends, confirms, installs or asks for a
// permission is drawn by Eos outside the frame, never inside it.

const LEVELS = { view: "View", page: "Page", app: "App" };

export function EosFrame({ maker, level = "view", children, below = null }) {
  const made = `Made by ${maker ?? "Eos"}`;
  return (
    <section className={level === "page" ? "eos-frame eos-frame--page" : "eos-frame"} aria-label={made}>
      <div className="eos-frame__strip">
        <span className="eos-frame__maker">{made}</span>
        <span className="eos-frame__level">{LEVELS[level] ?? level}</span>
      </div>
      <div className="eos-frame__content">{children}</div>
      {below && <div className="eos-frame__eos">{below}</div>}
    </section>
  );
}
