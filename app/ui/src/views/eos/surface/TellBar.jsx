import { useState } from "react";

// One line to tell Eos what to change, with the round send button of the
// Home input. `onSend(text)` answers { ok, error }; the text stays until it
// went.
export function TellBar({ label, onSend, autoFocus = false }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const send = async () => {
    const said = text.trim();
    if (!said || busy) return;
    setBusy(true);
    setError(null);
    const r = await onSend(said);
    setBusy(false);
    if (r?.ok) setText("");
    else setError(r?.error ?? "Eos did not take that.");
  };
  return (
    <div className="eos-tell">
      <form className="eos-tell__bar" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input
          type="text"
          className="eos-tell__input"
          aria-label={label}
          placeholder={label}
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="eos-tell__send" aria-label="Send" disabled={!text.trim() || busy}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16"><path d="M8 12.5v-9M4.5 7L8 3.5 11.5 7" /></svg>
        </button>
      </form>
      {error && <p className="eos-tell__error" role="alert">{error}</p>}
    </div>
  );
}
