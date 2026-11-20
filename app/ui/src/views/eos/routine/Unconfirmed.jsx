import { buildLocation, openLocation } from "../nav/eosNav.js";

// Why a routine does not resume yet (D53): the core's words, the recipients
// to confirm as the user reads them, and the way to the blueprint where they
// are confirmed. Labels come from outside: React text only.
export function UnconfirmedRecipients({ refusal, routineId }) {
  return (
    <div className="eos-refusal" role="alert">
      <span className="eos-band__text">{refusal.error}</span>
      <ul className="eos-recipients" aria-label="Recipients to confirm">
        {refusal.recipients.map((r) => <li key={r.id}>{r.label}</li>)}
      </ul>
      {routineId && (
        <button type="button" className="eos-btn eos-btn--primary" onClick={() => openLocation(buildLocation({ screen: "routine", routineId, tab: "blueprint" }))}>
          Review the change
        </button>
      )}
    </div>
  );
}
