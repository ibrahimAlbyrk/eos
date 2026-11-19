import { useState } from "react";
import { messageRun } from "../../../state/eos/runsStore.js";

// Tell the team: the user's words go to the run's lead. While the result is
// checked or waits for the user, this sends the work back (01 G18).
export function TellTeam({ runId, disabled }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const send = async (e) => {
    e.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    if (await messageRun(runId, text.trim())) setText("");
    setSending(false);
  };
  return (
    <form className="eos-tell" onSubmit={(e) => void send(e)}>
      <label className="eos-sr" htmlFor={`eos-tell-${runId}`}>Tell the team</label>
      <textarea
        id={`eos-tell-${runId}`}
        className="eos-tell__text"
        rows={2}
        placeholder="Tell the team…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" className="eos-btn eos-btn--primary" disabled={disabled || sending || !text.trim()}>Send</button>
    </form>
  );
}
