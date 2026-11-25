import { useCallback, useEffect, useMemo, useState } from "react";
import { ViewSurface } from "../../../genui/ViewBlock.jsx";
import { GenuiHostContext } from "../../../genui/runtime/host.jsx";
import { OptionFacts } from "../../../genui/runtime/optionFacts.js";
import { SubmitOutside } from "../../../genui/runtime/submitOutside.js";
import { notify } from "../../../lib/notify.js";
import { refreshInbox } from "../../../state/eos/inboxStore.js";
import { pressedRow, pressId, runSurfaceAction } from "../../../state/eos/surfacesStore.js";
import { EosFrame } from "../surface/EosFrame.jsx";

// A routine's View in Needs you, a choice or a form (05, 08 §4.9): drawn in
// EosFrame with an Eos host, so what the user picks or types goes with the
// press and each button runs only the action its issue declared. The facts
// the run handed in beside it show in its options' cards. When Eos
// asks first, it asks here, below the frame, never inside it. A form's send
// is Eos's too: the screen that holds the card draws it in its own actions
// (onSubmitOffer), else the card draws it under the frame.
export function SurfaceCard({ card, routineName, onSubmitOffer }) {
  const { issue, body } = card;
  const [ownSubmit, setOwnSubmit] = useState(null);
  const offer = onSubmitOffer ?? setOwnSubmit;
  const [asking, setAsking] = useState(null);
  const [typed, setTyped] = useState("");
  // The form's own offer, held back while Eos asks: its ask is then the one
  // way on, and the form's send must not stand beside it saying Sent.
  const [formOffer, setFormOffer] = useState(null);
  useEffect(() => offer(formOffer && asking ? { ...formOffer, phase: "asking", ready: false } : formOffer), [offer, formOffer, asking]);
  useEffect(() => () => offer(null), [offer]);
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
  const factsOf = useMemo(() => factsLookup(body.facts), [body.facts]);
  const confirm = async () => {
    const { press, token, typeToConfirm } = asking;
    ask(null);
    await settle(press, await runSurfaceAction({ ...press, confirm: token, ...(typeToConfirm ? { typed } : {}) }), ask);
  };
  const below = asking && (
    <ConfirmBelow asking={asking} typed={typed} onType={setTyped} onConfirm={() => void confirm()} onCancel={() => ask(null)} />
  );
  const frame = (
    <EosFrame maker={routineName} level="view" below={below} outside={body.untrusted === true}>
      <GenuiHostContext.Provider value={host}>
        <SubmitOutside.Provider value={setFormOffer}>
          <OptionFacts.Provider value={factsOf}>
            <ViewSurface viewId={issue.id} spec={body.view} ts={issue.createdAt} variant="panel" />
          </OptionFacts.Provider>
        </SubmitOutside.Provider>
      </GenuiHostContext.Provider>
    </EosFrame>
  );
  if (onSubmitOffer || !ownSubmit) return frame;
  return (
    <div className="eos-frame-with-send">
      {frame}
      <span className="eos-actions"><ViewSubmit offer={ownSubmit} /></span>
    </div>
  );
}

// The facts the run handed in beside its View, found by an option's label or
// value; null when it handed in none.
export function factsLookup(facts) {
  if (!Array.isArray(facts) || !facts.length) return null;
  return (label, value) => facts.find((f) => f.option === label || f.option === value)?.rows ?? null;
}

// The notes the run handed in beside its View (why Eos asks, what the
// answers change), drawn by Eos as plain text.
export function ViewAside({ notes }) {
  if (!Array.isArray(notes) || !notes.length) return null;
  return notes.map((note, i) => (
    <section key={i} className="eos-needs-aside__part">
      <h2 className="eos-label">{note.title}</h2>
      <p className="eos-needs-aside__text">{note.text}</p>
    </section>
  ));
}

// A View's form send, drawn by Eos outside the frame: its label, Sent once it
// went, and why it did not. While Eos asks below the frame it draws nothing.
export function ViewSubmit({ offer, shortcut, disabled = false }) {
  if (offer.phase === "asking") return null;
  return (
    <>
      <button type="button" className="eos-btn eos-btn--primary" disabled={disabled || !offer.ready || offer.phase === "sending"} onClick={offer.submit}>
        {offer.phase === "sent" ? "Sent" : offer.label}
        {shortcut && <span className="eos-needs-key"> {shortcut}</span>}
      </button>
      {offer.phase === "error" && <span className="eos-frame__send-error" role="alert">{offer.reason}</span>}
    </>
  );
}

// Whether what the user typed is the name an action that cannot be taken
// back asks for; one that asks for none goes on a click.
export function typedRight(typeToConfirm, typed) {
  return !typeToConfirm || typed.trim().toLowerCase() === typeToConfirm.trim().toLowerCase();
}

// Eos's own question below the frame: who asks, what it asks, and for what
// cannot be taken back the name the user types before Confirm goes. Cancel
// comes first, as in every ask of Eos's, and takes the focus when there is
// nothing to type, so Enter never confirms by accident.
export function ConfirmBelow({ asking, typed, onType, onConfirm, onCancel }) {
  const name = asking.typeToConfirm;
  return (
    <div className="eos-frame__ask" role="alertdialog" aria-label="Eos asks first">
      <p className="eos-label eos-frame__ask-label">Eos asks first</p>
      <p className="eos-frame__ask-text">{asking.prompt}</p>
      <div className="eos-frame__ask-foot">
        {name && (
          <label className="eos-frame__ask-type">
            <span className="eos-frame__ask-hint">Type <b>{name}</b> to go ahead</span>
            <input
              className="eos-bp-input"
              aria-label={`Type ${name} to go ahead`}
              placeholder={name}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(e) => onType(e.target.value)}
            />
          </label>
        )}
        <span className="eos-actions eos-frame__ask-acts">
          <button type="button" className="eos-btn eos-btn--quiet" autoFocus={!name} onClick={onCancel}>Cancel</button>
          <button type="button" className="eos-btn eos-btn--primary" disabled={!typedRight(name, typed)} onClick={onConfirm}>Confirm</button>
        </span>
      </div>
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
