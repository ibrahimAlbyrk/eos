import { useEffect } from "react";
import { loadRun, useRuns } from "../../../state/eos/runsStore.js";
import { openLocation } from "../nav/eosNav.js";
import { agentStateWord, hasEnded, ROLES, stateChip } from "../run/words.js";
import { runLocation } from "./RoutineRuns.jsx";

// The states in which a run's team is at work.
const WORKING = new Set(["running", "checking"]);

const capital = (word) => word.charAt(0).toUpperCase() + word.slice(1);

function Mark({ state }) {
  if (state === "done") {
    return <svg className="eos-now-agent__mark" width="11" height="11" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>;
  }
  if (state === "working") return <span className="eos-now-agent__dot" aria-hidden="true" />;
  return null;
}

// The team of the run at work, one small card each: who, and what it is at
// (its last line while it works, else its state). Agent lines are plain text.
function Team({ agents }) {
  return (
    <ol className="eos-now-team" aria-label="The team">
      {agents.map((a) => {
        const state = agentStateWord(a.state);
        const line = state === "working" && a.lastActivity ? a.lastActivity : capital(state);
        return (
          <li key={a.workerId} className={state === "working" ? "eos-now-agent eos-now-agent--working" : "eos-now-agent"}>
            <span className="eos-now-agent__name"><Mark state={state} />{a.name ?? ROLES[a.role] ?? a.role}</span>
            <span className="eos-now-agent__line">{line}</span>
          </li>
        );
      })}
    </ol>
  );
}

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
          {agents?.length > 0 && <Team agents={agents} />}
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
