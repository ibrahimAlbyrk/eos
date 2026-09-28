// Paste-and-save for a provider's API key. A preset's key is checked live before
// it is stored (accountsStore.saveApiKey), so the button reads "Checking…".

import { useState } from "react";
import { saveApiKey } from "../../state/accountsStore.js";
import { metaFor } from "./providerMeta.js";
import { EyeIcon } from "./icons.jsx";

export function ApiKeyField({ account, onDone, onCancel, autoFocus = false }) {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const name = metaFor(account).name;

  const save = async (e) => {
    e.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true);
    setError(null);
    const r = await saveApiKey(account, value);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setValue("");
    onDone?.();
  };

  return (
    <form className="acc-key" onSubmit={save}>
      <div className={"acc-key__field" + (error ? " is-err" : "")}>
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          placeholder={`Paste your ${name} API key`}
          aria-label={`${name} API key`}
          spellCheck={false}
          autoComplete="off"
          autoFocus={autoFocus}
          disabled={busy}
        />
        <button type="button" className="acc-key__eye" aria-label={show ? "Hide key" : "Show key"} onClick={() => setShow((v) => !v)}>
          <EyeIcon size={13} off={show} />
        </button>
      </div>
      <div className="acc-key__actions">
        {onCancel && <button type="button" className="acc-btn acc-btn--ghost" onClick={onCancel} disabled={busy}>Cancel</button>}
        <button type="submit" className="acc-btn acc-btn--quiet" disabled={!value.trim() || busy}>
          {busy ? (account.id === "anthropic" ? "Saving…" : "Checking…") : "Save key"}
        </button>
      </div>
      {error && <div className="acc-err" role="alert">{error}</div>}
    </form>
  );
}
