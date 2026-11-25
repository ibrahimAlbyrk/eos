import { useEffect, useState } from "react";
import { moveHere } from "../../../state/eos/runnersStore.js";
import { sinceWord } from "./Holder.jsx";

// Move here (02 §3 F.32): what the move does and what may happen twice,
// then the claim. A Mac without a capability the routine reads is refused
// in the core's words ("Connect GitHub on this Mac first").
export function MoveDialog({ routine, holder, onClose }) {
  const [phase, setPhase] = useState({ at: "ask" });
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const move = async () => {
    setPhase({ at: "moving" });
    const answer = await moveHere(routine.id);
    if (answer.moved) onClose();
    else if (answer.error) setPhase({ at: "ask", error: answer.error });
    else setPhase({ at: "lost" });
  };
  return (
    <div className="eos-sheet-overlay" onMouseDown={onClose}>
      <div className="eos-sheet" role="dialog" aria-modal="true" aria-labelledby="eos-move-title" onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="eos-move-title" className="eos-sheet__title">Move {routine.name} to this Mac?</h2>
        {phase.at === "lost" ? (
          <p className="eos-note" role="status">Another Mac moved it first. It runs there now.</p>
        ) : (
          <>
            <p className="eos-note">
              {holder.name} has been away since {sinceWord(holder.awaySince)}. This Mac takes {routine.name} up where {holder.name} left
              off: what came in since then is looked at here, and a schedule it missed runs once.
            </p>
            <p className="eos-note">
              What {holder.name} did in its last ten minutes before it went away may be done again, such as a review posted or a mail
              sent twice. When {holder.name} comes back, it stops running {routine.name}.
            </p>
            {phase.error && <p className="eos-note" role="alert">{phase.error}</p>}
          </>
        )}
        <div className="eos-actions">
          {phase.at !== "lost" && (
            <button type="button" className="eos-btn eos-btn--primary" disabled={phase.at === "moving"} onClick={() => void move()}>Move here</button>
          )}
          <button type="button" className="eos-btn" onClick={onClose}>{phase.at === "lost" ? "Close" : "Cancel"}</button>
        </div>
      </div>
    </div>
  );
}
