// The strip above anything a routine generated (08 §4.11): who made it and how
// much it can do. Everything that sends, confirms, installs or asks for a
// permission is drawn by Eos outside the frame, never inside it.

const LEVELS = { view: "View", page: "Page", app: "App" };

// `outside`: a run that read outside text made it; its words show as written.
// `detail`: one more fact beside who made it, such as which issue this is.
// `tools`: what the strip offers at its right in place of the level, such as
// the way to the issues before and after.
export function EosFrame({ maker, level = "view", children, below = null, outside = false, detail = null, tools = null }) {
  const made = `Made by ${maker ?? "Eos"}`;
  // A View sits among Eos's own controls, so its strip says who drew it and
  // that only Eos's buttons under it act; a Page or an App names its level.
  const said = level === "view" ? `Drawn by ${maker ?? "Eos"}. Only the buttons under it act.` : made;
  return (
    <section className={level === "page" ? "eos-frame eos-frame--page" : "eos-frame"} aria-label={made}>
      <div className="eos-frame__strip">
        <span className="eos-frame__maker">{said}{detail && <span className="eos-frame__detail"> · {detail}</span>}</span>
        {outside && <span className="eos-frame__outside" title="The run read text from outside Eos. Its words show here as written.">From outside text</span>}
        {tools ?? (level !== "view" && <span className="eos-frame__level">{LEVELS[level] ?? level}</span>)}
      </div>
      <div className="eos-frame__content">{children}</div>
      {below && <div className="eos-frame__eos">{below}</div>}
    </section>
  );
}
