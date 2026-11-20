import { useEffect, useState } from "react";
import { flagDeliveryWrong, stopDelivery, undoDelivery, useInbox } from "../../../state/eos/inboxStore.js";
import { secondsLeft, SEND_NOTES } from "./words.js";

// Ticks once a second while something on screen counts down.
function useTick(ticking) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!ticking) return undefined;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
}

// A draft's sends after the user's Send (03 G6): in its hold, "Sending…
// Undo" with the seconds left and Stop; once out, Undo while its channel can
// take it back, and "That was wrong" sent or undone. Drawn by Eos, outside
// any surface frame.
export function SendState({ detail }) {
  const { sendNotes, offline } = useInbox();
  const now = Date.now();
  const deliveries = detail.deliveries ?? [];
  const holding = deliveries.find((d) => d.state === "holding");
  const undoable = (d) => d.state === "sent" && d.undoUntil > now && sendNotes[d.id] !== "cannot_undo";
  const out = deliveries.filter((d) => d.state === "sent" || d.state === "undone");
  useTick(Boolean(holding) || deliveries.some(undoable));
  if (!holding && out.length === 0) return null;
  const itemId = detail.item.id;
  return (
    <div className="eos-send-state">
      {holding && (
        <p className="eos-send-state__line" role="status">
          <span>Sending… Undo</span>
          <span className="eos-send-state__left">{secondsLeft(holding.sendAt, now)}</span>
          <button type="button" className="eos-btn" disabled={offline} onClick={() => void stopDelivery(itemId, holding.id)}>Stop</button>
        </p>
      )}
      {out.map((d) => (
        <p key={d.id} className="eos-send-state__line">
          {SEND_NOTES[sendNotes[d.id] ?? d.state] && <span role="status">{SEND_NOTES[sendNotes[d.id] ?? d.state]}</span>}
          {undoable(d) && (
            <button type="button" className="eos-btn" disabled={offline} onClick={() => void undoDelivery(itemId, d.id)}>Undo</button>
          )}
          <button
            type="button"
            className="eos-btn"
            disabled={offline || sendNotes[d.id] === "wrong"}
            onClick={() => void flagDeliveryWrong(itemId, d.id)}
          >
            That was wrong
          </button>
        </p>
      ))}
    </div>
  );
}
