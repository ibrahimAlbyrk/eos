import { fmtUsd } from "../../../lib/format.js";
import { modelName } from "../../../lib/models.js";
import { useRuns } from "../../../state/eos/runsStore.js";
import { ROLES } from "../run/words.js";
import { WhyPanel } from "./WhyPanel.jsx";

// The aside of an item a run made: the notes that shaped it, and who worked
// on it at what cost, once the run is read. `lead`
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
  const { agents } = run;
  return (
    <>
      <WhyPanel runId={runId} />
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
