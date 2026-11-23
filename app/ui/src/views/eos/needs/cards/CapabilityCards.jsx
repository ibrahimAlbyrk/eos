import { CLASSES, stateLine } from "../../capabilities/words.js";

// A capability Eos proposes to add (06): what it does, each action with what
// it counts as, and what it reaches. Install is the user's, outside the frame.
export function CapabilityProposal({ detail }) {
  const { name, summary, actions = [], reach = {} } = detail.payload ?? {};
  const reaches = [...(reach.hosts ?? []), ...(reach.apps ?? []), ...(reach.files ?? [])];
  return (
    <div className="eos-needs-card">
      <p className="eos-needs-card__lead"><strong>{name ?? detail.item.title}</strong>{summary ? ` · ${summary}` : ""}</p>
      {actions.length > 0 && (
        <ul className="eos-needs-card__list" aria-label="What it can do">
          {actions.map((a) => (
            <li key={a.name}>{a.summary ?? a.name}<span className="eos-needs-card__class"> · {CLASSES[a.class] ?? a.class}</span></li>
          ))}
        </ul>
      )}
      <p className="eos-needs-card__class">{reaches.length ? `Reaches ${reaches.join(", ")}` : "Reaches nothing outside this Mac."}</p>
    </div>
  );
}

// A capability that needs the user before it works again: why, in words.
export function CapabilityProblem({ detail }) {
  const why = stateLine({ state: "needs_setup", stateCode: detail.payload?.stateCode });
  return (
    <div className="eos-needs-card">
      {detail.item.summary && <p className="eos-needs-card__lead">{detail.item.summary}</p>}
      {why && <p className="eos-needs-card__class">{why}</p>}
    </div>
  );
}
