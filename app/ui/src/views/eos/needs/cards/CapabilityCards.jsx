import { CLASSES, stateLine } from "../../capabilities/words.js";

// What the live test's state says to the user (eos-contracts `LiveTest`).
const LIVE_WORDS = {
  not_run: "Send one real test first. Nothing goes out until you press Send a test.",
  sent: "Eos sent the test. Did your phone alert you?",
  failed: "The test did not go out. You can send it again.",
  alerted: "The test reached you.",
  not_alerted: "The test did not reach you. Decline it, or ask Eos for another way.",
};

export const liveStateOf = (detail) => detail.payload?.liveTest?.state;
export const settingKey = (name) => `setting:${name}`;

// A capability Eos proposes to add (06 G9, eos-contracts `CapabilityProposal`):
// what it does, each action with what it counts as, what it reaches and
// costs, how it was tested and reviewed, and what Eos cannot promise. Install
// is the user's, outside the frame; a secret is asked in the app's own prompt.
export function CapabilityProposal({ detail, values = {}, setValue = () => {} }) {
  const p = detail.payload ?? {};
  const { name, summary, actions = [], reach = {}, secrets = [], settings = [], routines = [], limits = [] } = p;
  const reaches = [...(reach.hosts ?? []), ...(reach.apps ?? []), ...(reach.files ?? [])];
  const live = liveStateOf(detail);
  const findings = p.review?.findings?.length ?? 0;
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
      {p.cost && <p className="eos-needs-card__class">Costs: {p.cost}</p>}
      {secrets.length > 0 && (
        <p className="eos-needs-card__class">Asks in Eos's own prompt for: {secrets.map((s) => s.label).join(", ")}</p>
      )}
      {p.tests && (
        <p className="eos-needs-card__class">
          {p.tests.passed ? "Eos's tests passed under the sandbox" : "Eos's tests did not pass"}
          {p.review?.verdict === "pass" ? `; the reviewer passed it${findings ? ` with ${findings} notes` : ""}.` : "."}
        </p>
      )}
      {routines.length > 0 && <p className="eos-needs-card__class">Waiting for it: {routines.map((r) => r.name).join(", ")}</p>}
      {live && <p className="eos-needs-card__lead">{LIVE_WORDS[live] ?? live}</p>}
      {live && live !== "alerted" && live !== "sent" && settings.map((s) => {
        const field = `eos-setting-${s.name}`;
        return (
          <div key={s.name} className="eos-needs-question">
            <label htmlFor={field} className="eos-needs-question__text">{s.label}</label>
            <input
              id={field}
              className="eos-needs-question__answer"
              value={values[settingKey(s.name)] ?? ""}
              onChange={(e) => setValue(settingKey(s.name), e.target.value)}
            />
          </div>
        );
      })}
      {limits.length > 0 && (
        <ul className="eos-needs-card__list eos-needs-card__class" aria-label="What Eos cannot promise">
          {limits.map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}
    </div>
  );
}

// A capability that needs the user before it works again: why, in words.
export function CapabilityProblem({ detail }) {
  const why = stateLine({ state: detail.payload?.state ?? "needs_setup", stateCode: detail.payload?.stateCode });
  return (
    <div className="eos-needs-card">
      {detail.item.summary && <p className="eos-needs-card__lead">{detail.item.summary}</p>}
      {why && <p className="eos-needs-card__class">{why}</p>}
      {detail.payload?.goBack && <p className="eos-needs-card__class">Version {detail.payload.goBack} still works on this Mac.</p>}
    </div>
  );
}
