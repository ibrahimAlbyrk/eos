import { messageRun } from "../../../state/eos/runsStore.js";
import { TellBar } from "../surface/TellBar.jsx";

// Tell the team: the user's words go to the run's lead, in the same bar a
// page is changed by. While the result is checked or waits for the user,
// this sends the work back (01 G18).
export function TellTeam({ runId }) {
  return (
    <div className="eos-run__tell">
      <TellBar label="Tell the team something" onSend={async (text) => ({ ok: Boolean(await messageRun(runId, text)) })} />
    </div>
  );
}
