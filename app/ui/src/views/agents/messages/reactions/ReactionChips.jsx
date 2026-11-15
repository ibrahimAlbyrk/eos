import { useEffect, useMemo, useState } from "react";
import { ActivityStar } from "../ActivityStar.jsx";

// How long after it appeared here a chip still pops in: one that was already
// there (a chat opened, a page of history) just shows.
const NEW_MS = 600;
const isNew = (r) => r.born != null && Date.now() - r.born < NEW_MS;

// The user's own reaction. While its countdown runs (the reaction is about to
// start an agent turn) a bar drains along the bottom and a click still takes it
// back before anything is sent; once the agent has been told, its star slides in.
function MyChip({ reaction: r, onRemove }) {
  const until = r.seen ? null : r.wakesUntil ?? null;
  // Measured once per countdown: the bar's duration must not change mid-run.
  const total = useMemo(() => (until == null ? 0 : Math.max(0, until - Date.now())), [until]);
  const [spent, setSpent] = useState(null);
  useEffect(() => {
    if (total <= 0) return undefined;
    const t = setTimeout(() => setSpent(until), total);
    return () => clearTimeout(t);
  }, [until, total]);
  const sending = total > 0 && spent !== until;
  const title = r.seen ? "Seen by the agent" : sending ? "Sending… click to undo" : "Goes with your next message";
  return (
    <button
      type="button"
      className={"rx-chip rx-mine" + (r.seen ? " is-seen" : "") + (isNew(r) ? " is-new" : "")}
      onClick={onRemove}
      title={title}
      aria-label={`Your reaction ${r.emoji}. ${title}. Click to remove`}
    >
      <span className="rx-emoji">{r.emoji}</span>
      <span className="rx-seen" aria-hidden="true"><ActivityStar /></span>
      {sending && <i className="rx-drain" key={until} style={{ animationDuration: `${total}ms` }} />}
    </button>
  );
}

// The reactions under a message: the agent's (its star, then the emoji) and the
// user's own.
export function ReactionChips({ reactions, onRemove }) {
  const { user, agent } = reactions;
  return (
    <div className="msg-rx">
      {agent && (
        <span className={"rx-chip rx-agent" + (isNew(agent) ? " is-new" : "")} title="The agent reacted">
          <ActivityStar />
          <span className="rx-emoji">{agent.emoji}</span>
        </span>
      )}
      {user && <MyChip reaction={user} onRemove={onRemove} />}
    </div>
  );
}
