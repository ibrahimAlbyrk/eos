import { fmtUsd } from "../../../lib/format.js";
import { modelName } from "../../../lib/models.js";
import { agentStateWord, ROLES } from "./words.js";

// One agent of the run: its state's mark, its name or role, what it has
// cost, its model and state, and what it did last, at most three lines
// (run:activity; before the first, the last line the core knew). Agent
// lines are plain text.
export function TeamCard({ agent, lines }) {
  const shown = lines?.length ? lines : agent.lastActivity ? [agent.lastActivity] : [];
  const state = agentStateWord(agent.state);
  return (
    <article className={state === "working" ? "eos-card eos-team-card eos-team-card--working" : "eos-card eos-team-card"} aria-label={agent.name ?? ROLES[agent.role] ?? agent.role}>
      <div className="eos-team-card__head">
        <span className={`eos-team-card__mark eos-team-card__mark--${state}`} aria-hidden="true" />
        <span className="eos-team-card__name">{agent.name ?? ROLES[agent.role] ?? agent.role}</span>
        {agent.costUsd > 0 && <span className="eos-team-card__cost">{fmtUsd(agent.costUsd)}</span>}
        <span className="eos-team-card__side">{[agent.model && modelName(agent.model), state].filter(Boolean).join(" · ")}</span>
      </div>
      {shown.length > 0 && (
        <ul className="eos-team-card__lines" role="status">
          {shown.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      )}
    </article>
  );
}
