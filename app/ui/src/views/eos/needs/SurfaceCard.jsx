import { useMemo, useState } from "react";
import { ViewSurface } from "../../../genui/ViewBlock.jsx";
import { GenuiHostContext } from "../../../genui/runtime/host.jsx";
import { notify } from "../../../lib/notify.js";
import { refreshInbox } from "../../../state/eos/inboxStore.js";
import { pressId, runSurfaceAction } from "../../../state/eos/surfacesStore.js";
import { EosFrame } from "../surface/EosFrame.jsx";

// A routine's View in Needs you, a choice or a form (05, 08 §4.9): drawn in
// EosFrame with an Eos host, so what the user picks or types goes with the
// press and each button runs only the action its issue declared. When Eos
// asks first, it asks here, below the frame, never inside it.
export function SurfaceCard({ card, routineName }) {
  const { issue, body } = card;
  const [asking, setAsking] = useState(null);
  const host = useMemo(() => ({
    directActions: true,
    send: async (text, opts) => {
      const press = { issueId: issue.id, actionId: opts?.action?.actionId, state: opts?.action?.state, clientId: pressId() };
      return settle(press, await runSurfaceAction(press), setAsking);
    },
  }), [issue.id]);
  const confirm = async () => {
    const { press, token } = asking;
    setAsking(null);
    await settle(press, await runSurfaceAction({ ...press, confirm: token }), setAsking);
  };
  const below = asking && (
    <div className="eos-frame__ask" role="alertdialog" aria-label="Eos asks first">
      <p className="eos-frame__ask-text">{asking.prompt}</p>
      <span className="eos-actions">
        <button type="button" className="eos-btn eos-btn--primary" onClick={() => void confirm()}>Confirm</button>
        <button type="button" className="eos-btn" onClick={() => setAsking(null)}>Cancel</button>
      </span>
    </div>
  );
  return (
    <EosFrame maker={routineName} level="view" below={below}>
      <GenuiHostContext.Provider value={host}>
        <ViewSurface viewId={issue.id} spec={body.view} ts={issue.createdAt} variant="panel" />
      </GenuiHostContext.Provider>
    </EosFrame>
  );
}

// What the core answered a press, as the view's runtime reads it.
async function settle(press, answer, setAsking) {
  switch (answer.status) {
    case "done":
      return { ok: true };
    case "confirm":
      setAsking({ press, token: answer.token, prompt: answer.prompt });
      return { ok: true };
    case "held":
      notify.info("It waits in Needs you for you to send.");
      void refreshInbox();
      return { ok: true };
    default:
      return { ok: false, status: 0, body: { error: answer.reason } };
  }
}
