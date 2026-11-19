import { fmtCost } from "../../../lib/format.js";
import { useRuns } from "../../../state/eos/runsStore.js";

const ROLES = { lead: "Lead", solo: "Worker", specialist: "Specialist", checker: "Checker" };

// The aside of an item a run made: what its checker found, and who worked on
// it at what cost. Drawn once the run is read.
export function ChecksPanel({ runId }) {
  const run = useRuns().details[runId];
  if (!run) return null;
  const { verdict, agents } = run;
  return (
    <aside className="eos-needs-aside" aria-label="About this result">
      {verdict && (
        <section className="eos-needs-aside__part">
          <h2 className="eos-label">Checked before it reached you</h2>
          <p className="eos-needs-aside__lead">{verdict.pass ? "It passed every check." : "It did not pass every check."}</p>
          <ul className="eos-needs-checks">
            {verdict.checks.map((c) => (
              <li key={c.key}>
                <span className={c.ok ? "eos-status eos-status--ok" : "eos-status eos-status--err"}>{c.ok ? "Passed" : "Failed"}</span>
                <span className="eos-needs-checks__note">{c.note}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="eos-needs-aside__part">
        <h2 className="eos-label">Who worked on it</h2>
        <ul className="eos-needs-team">
          {agents.map((a) => (
            <li key={a.workerId}>
              <span>{a.name ?? ROLES[a.role] ?? a.role}</span>
              <span className="eos-needs-team__side">{[a.model, fmtCost(a.costUsd)].filter(Boolean).join(" · ")}</span>
            </li>
          ))}
        </ul>
        <p className="eos-needs-aside__lead">In all {fmtCost(run.run.costUsd)}</p>
      </section>
    </aside>
  );
}
