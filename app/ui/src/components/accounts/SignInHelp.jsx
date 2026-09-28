// The fallback row under a sign-in in flight: copy the sign-in link when the
// browser didn't open, or paste the code the provider's page shows when its
// redirect can't reach this Mac.

import { useState } from "react";
import { submitSignInCode } from "../../state/accountsStore.js";
import { CopyIcon } from "./icons.jsx";

export function SignInHelp({ provider, session, onCancel = null }) {
  const [pasting, setPasting] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard?.writeText(session.url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  const send = async (e) => {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    const r = await submitSignInCode(provider, code.trim());
    setBusy(false);
    if (r.ok) setCode("");
    else setError(r.error);
  };

  if (pasting) {
    return (
      <form className="acc-help acc-help--code" onSubmit={send}>
        <input
          className="acc-input"
          value={code}
          onChange={(e) => { setCode(e.target.value); setError(null); }}
          placeholder="Paste the code from your browser"
          aria-label="Sign-in code"
          spellCheck={false}
          autoComplete="off"
          autoFocus
        />
        <button type="submit" className="acc-btn acc-btn--quiet" disabled={!code.trim() || busy}>{busy ? "Sending…" : "Send"}</button>
        {error && <div className="acc-err" role="alert">{error}</div>}
      </form>
    );
  }

  return (
    <div className="acc-help">
      <span>Browser didn't open?</span>
      <span className="acc-help__actions">
        {session?.url && (
          <button type="button" onClick={copy}><CopyIcon size={12} />{copied ? "Copied" : "Copy link"}</button>
        )}
        {session?.codeEntry && <button type="button" onClick={() => setPasting(true)}>Paste code</button>}
        {onCancel && <button type="button" className="is-quiet" onClick={onCancel}>Cancel</button>}
      </span>
    </div>
  );
}
