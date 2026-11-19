import { modelShort } from "../../../lib/format.js";
import { agentStateWord, ROLES } from "./words.js";

// One agent of the run: its name or role, its model and state, and what it
// did last, at most three lines (run:activity; before the first, the last
// line the core knew). Agent lines are plain text.
export function TeamCard({ agent, lines }) {
  const shown = lines?.length ? lines : agent.lastActivity ? [agent.lastActivity] : [];
  const state = agentStateWord(agent.state);
  return (
    <article className="eos-card eos-team-card" aria-label={agent.name ?? ROLES[agent.role] ?? agent.role}>
      <div className="eos-team-card__head">
        <span className="eos-team-card__name">{agent.name ?? ROLES[agent.role] ?? agent.role}</span>
        <span className="eos-team-card__side">{[agent.model && modelShort(agent.model), state].filter(Boolean).join(" · ")}</span>
      </div>
      {shown.length > 0 && (
        <ul className="eos-team-card__lines" role="status">
          {shown.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      )}
    </article>
  );
}
