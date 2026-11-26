import { fmtUsd } from "../../../lib/format.js";
import { modelName } from "../../../lib/models.js";
import { useRuns } from "../../../state/eos/runsStore.js";
import { ROLES } from "../run/words.js";
import { WhyPanel } from "./WhyPanel.jsx";

// The aside of an item a run made: the notes that shaped it, what its checker
// found, and who worked on it at what cost, once the run is read. `lead`
// comes first: what a View's run wrote beside it. `whyOnly` keeps just the
// notes, for an item that asks rather than delivers.
export function ChecksPanel({ runId, lead = null, whyOnly = false }) {
  const run = useRuns().details[runId];
  if (!run && !lead) return null;
  return (
    <aside className="eos-needs-aside" aria-label="About this result">
      {lead}
      {run && (whyOnly ? <WhyPanel runId={runId} /> : <RunParts runId={runId} run={run} />)}
    </aside>
  );
}

function RunParts({ runId, run }) {
  const { verdict, agents } = run;
  return (
    <>
      <WhyPanel runId={runId} />
      {verdict && (
        <section className="eos-needs-aside__part">
          <h2 className="eos-label">Checked before it reached you</h2>
          <p className="eos-needs-aside__lead">{verdict.pass ? "It passed every check." : "It did not pass every check."}</p>
          <ul className="eos-needs-checks">
            {verdict.checks.map((c) => (
              <li key={c.key}>
                <span className={c.ok ? "eos-needs-checks__mark eos-needs-checks__mark--ok" : "eos-needs-checks__mark eos-needs-checks__mark--err"}>
                  <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16"><path d={c.ok ? "M3.5 8.5l3 3 6-7" : "M4.5 4.5l7 7m0-7l-7 7"} /></svg>
                  <span className="eos-sr">{c.ok ? "Passed" : "Failed"}</span>
                </span>
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
              <span className="eos-needs-team__side">{[a.model && modelName(a.model), fmtUsd(a.costUsd)].filter(Boolean).join(" · ")}</span>
            </li>
          ))}
        </ul>
        <p className="eos-needs-aside__lead">In all {fmtUsd(run.run.costUsd)}</p>
      </section>
    </>
  );
}
