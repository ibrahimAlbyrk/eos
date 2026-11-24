import { useCallback, useEffect, useMemo, useState } from "react";
import { ViewSurface } from "../../../genui/ViewBlock.jsx";
import { GenuiHostContext } from "../../../genui/runtime/host.jsx";
import { notify } from "../../../lib/notify.js";
import { refreshInbox } from "../../../state/eos/inboxStore.js";
import { loadItemView, pressedRow, pressId, runSurfaceAction, useSurfaces } from "../../../state/eos/surfacesStore.js";
import { EosFrame } from "../surface/EosFrame.jsx";

// A routine's View in Needs you, a choice or a form (05, 08 §4.9): drawn in
// EosFrame with an Eos host, so what the user picks or types goes with the
// press and each button runs only the action its issue declared. When Eos
// asks first, it asks here, below the frame, never inside it.
export function SurfaceCard({ card, routineName }) {
  const { issue, body } = card;
  const [asking, setAsking] = useState(null);
  const [typed, setTyped] = useState("");
  const ask = useCallback((next) => {
    setTyped("");
    setAsking(next);
  }, []);
  const host = useMemo(() => ({
    directActions: true,
    send: async (text, opts) => {
      const press = {
        issueId: issue.id, actionId: opts?.action?.actionId, state: opts?.action?.state, clientId: pressId(),
        ...pressedRow(body.view?.data, opts?.action?.item),
      };
      return settle(press, await runSurfaceAction(press), ask);
    },
  }), [issue.id, body, ask]);
  const confirm = async () => {
    const { press, token, typeToConfirm } = asking;
    ask(null);
    await settle(press, await runSurfaceAction({ ...press, confirm: token, ...(typeToConfirm ? { typed } : {}) }), ask);
  };
  const below = asking && (
    <ConfirmBelow asking={asking} typed={typed} onType={setTyped} onConfirm={() => void confirm()} onCancel={() => ask(null)} />
  );
  return (
    <EosFrame maker={routineName} level="view" below={below}>
      <GenuiHostContext.Provider value={host}>
        <ViewSurface viewId={issue.id} spec={body.view} ts={issue.createdAt} variant="panel" />
      </GenuiHostContext.Provider>
    </EosFrame>
  );
}

// The View a Needs-you item shows (a card, or a question whose press answers
// its run), drawn once its issue is read.
export function ItemView({ item, routineName }) {
  const card = useSurfaces().byIssue[item.view.issueId];
  useEffect(() => { void loadItemView(item.view); }, [item.view]);
  return card ? <SurfaceCard card={card} routineName={routineName} /> : null;
}

// Whether what the user typed is the name an action that cannot be taken
// back asks for; one that asks for none goes on a click.
export function typedRight(typeToConfirm, typed) {
  return !typeToConfirm || typed.trim().toLowerCase() === typeToConfirm.trim().toLowerCase();
}

// Eos's own question below the frame. For what cannot be taken back the
// user types its name before Confirm goes.
export function ConfirmBelow({ asking, typed, onType, onConfirm, onCancel }) {
  const name = asking.typeToConfirm;
  return (
    <div className="eos-frame__ask" role="alertdialog" aria-label="Eos asks first">
      <p className="eos-frame__ask-text">{asking.prompt}</p>
      {name && (
        <input
          className="eos-input"
          aria-label={`Type ${name} to go ahead`}
          placeholder={name}
          value={typed}
          onChange={(e) => onType(e.target.value)}
        />
      )}
      <span className="eos-actions">
        <button type="button" className="eos-btn eos-btn--primary" disabled={!typedRight(name, typed)} onClick={onConfirm}>Confirm</button>
        <button type="button" className="eos-btn" onClick={onCancel}>Cancel</button>
      </span>
    </div>
  );
}

// What the core answered a press, as the view's runtime reads it.
async function settle(press, answer, setAsking) {
  switch (answer.status) {
    case "done":
      return { ok: true };
    case "confirm":
      setAsking({ press, token: answer.token, prompt: answer.prompt, typeToConfirm: answer.typeToConfirm });
      return { ok: true };
    case "held":
      notify.info("It waits in Needs you for you to send.");
      void refreshInbox();
      return { ok: true };
    default:
      return { ok: false, status: 0, body: { error: answer.reason } };
  }
}
