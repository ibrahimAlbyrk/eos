import { useEffect } from "react";
import { loadRun, useRuns } from "../../../state/eos/runsStore.js";
import { openLocation } from "../nav/eosNav.js";
import { hasEnded, stateChip } from "../run/words.js";
import { TeamCard } from "../run/TeamCard.jsx";
import { runLocation } from "./RoutineRuns.jsx";

// The states in which a run's team is at work.
const WORKING = new Set(["running", "checking"]);

const chipClass = (chip) => (chip.tone ? `eos-status eos-status--${chip.tone}` : "eos-status");

function Row({ run, now }) {
  return (
    <li className="eos-run-row eos-run-row__open">
      <span className="eos-run-row__title">{run.itemTitle ?? "Run"}</span>
      <span className="eos-run-row__line"><span className={chipClass(stateChip(run, now))}>{stateChip(run, now).text}</span></span>
      <button type="button" className="eos-link" onClick={() => openLocation(runLocation(run.id))}>Open the run</button>
    </li>
  );
}

// Right now: the routine's runs that have not ended, when there are any. The first whose team is
// at work leads, with its team as the run shows it; the others are rows with
// their state and the way to them. Item titles come from outside: React text
// only.
export function RightNow({ runs, now }) {
  const live = runs.filter((r) => !hasEnded(r));
  const lead = live.find((r) => WORKING.has(r.state));
  const leadId = lead?.id;
  const agents = useRuns().details[leadId]?.agents;
  useEffect(() => { if (leadId) void loadRun(leadId); }, [leadId]);
  const rest = live.filter((r) => r !== lead);
  // With nothing at work the lead above says so; the section stays away.
  if (live.length === 0) return null;
  return (
    <section className="eos-routine__section eos-routine__now" aria-label="Right now">
      <div className="eos-routine__head">
        <h2 className="eos-label">Right now</h2>
        {lead && <button type="button" className="eos-link" onClick={() => openLocation(runLocation(lead.id))}>Open the run</button>}
      </div>
      {lead && (
        <div className="eos-now-lead">
          <p className="eos-now-lead__title">
            <span className="eos-now-lead__item">{lead.itemTitle ?? "A run"}</span>
            <span className={chipClass(stateChip(lead, now))}>{stateChip(lead, now).text}</span>
          </p>
          {agents?.length > 0 && (
            <div className="eos-team__cards" aria-label="The team">
              {agents.map((a) => <TeamCard key={a.workerId} agent={a} />)}
            </div>
          )}
        </div>
      )}
      {rest.length > 0 && (
        <ul className="eos-runs">
          {rest.map((r) => <Row key={r.id} run={r} now={now} />)}
        </ul>
      )}
    </section>
  );
}
