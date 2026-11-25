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

// The hold draining away: a hairline that empties over the time left, once,
// from when it was first drawn.
function Drain({ sendAt }) {
  const [ms] = useState(() => Math.max(0, sendAt - Date.now()));
  return <span className="eos-send-state__drain" aria-hidden="true"><span style={{ animationDuration: `${ms}ms` }} /></span>;
}

// A note's tone, by what became of the send.
const TONES = { sent: "ok", cannot_undo: "ok", undone: "done", partial: "warn", wrong: "done" };

// A draft's sends after the user's Send (03 G6), each as a fact under the
// lead: in its hold, "Sending…" with the seconds left draining and Stop;
// waiting its turn, a hollow mark and Stop; on its way, lit; once out, Undo
// while its channel can take it back, and "That was wrong" sent or undone,
// once (`wrong` keeps it across reloads). Drawn by Eos, outside any surface
// frame.
export function SendState({ detail }) {
  const { sendNotes, offline } = useInbox();
  const now = Date.now();
  const deliveries = detail.deliveries ?? [];
  const holding = deliveries.find((d) => d.state === "holding");
  const undoable = (d) => d.state === "sent" && d.undoUntil > now && sendNotes[d.id] !== "cannot_undo";
  const queued = deliveries.find((d) => d.state === "queued");
  const sending = deliveries.some((d) => d.state === "sending");
  const out = deliveries.filter((d) => d.state === "sent" || d.state === "undone");
  useTick(Boolean(holding) || deliveries.some(undoable));
  if (!holding && !queued && !sending && out.length === 0) return null;
  const itemId = detail.item.id;
  return (
    <div className="eos-send-state">
      {holding && (
        <p className="eos-send-state__line eos-fact eos-fact--active eos-send-state__line--holding" role="status">
          <span>Sending…</span>
          <span className="eos-send-state__left">{secondsLeft(holding.sendAt, now)}</span>
          <Drain key={holding.id} sendAt={holding.sendAt} />
          <button type="button" className="eos-btn" disabled={offline} onClick={() => void stopDelivery(itemId, holding.id)}>Stop</button>
        </p>
      )}
      {queued && (
        <p className="eos-send-state__line eos-fact" role="status">
          <span>{SEND_NOTES.queued}</span>
          <button type="button" className="eos-btn" disabled={offline} onClick={() => void stopDelivery(itemId, queued.id)}>Stop</button>
        </p>
      )}
      {sending && <p className="eos-send-state__line eos-fact eos-fact--active" role="status">{SEND_NOTES.sending}</p>}
      {out.map((d) => {
        const note = sendNotes[d.id] ?? (d.wrong ? "wrong" : d.state);
        return (
          <p key={d.id} className={`eos-send-state__line eos-fact eos-fact--${TONES[note] ?? "done"}`}>
            {SEND_NOTES[note] && <span role="status">{SEND_NOTES[note]}</span>}
            {undoable(d) && (
              <button type="button" className="eos-btn" disabled={offline} onClick={() => void undoDelivery(itemId, d.id)}>Undo</button>
            )}
            <button
              type="button"
              className="eos-btn eos-btn--quiet"
              disabled={offline || d.wrong || sendNotes[d.id] === "wrong"}
              onClick={() => void flagDeliveryWrong(itemId, d.id)}
            >
              That was wrong
            </button>
          </p>
        );
      })}
    </div>
  );
}
