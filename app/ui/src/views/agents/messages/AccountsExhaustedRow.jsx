// Every Claude sign-in of the session is out (accounts_exhausted): when the next
// limit lifts, and what the user can do — have Eos pick the turn up then, or go
// on per token with the API key (this session only, never automatic).

import { useState } from "react";
import { api } from "../../../api/client.js";

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const failure = (r, fallback) => (r ? r.body?.error ?? `${fallback} (HTTP ${r.status})` : "Eos isn't reachable.");

export function exhaustedText(block) {
  return block.nextResetAt
    ? `All Claude accounts are at their limit · next reset ${clock(block.nextResetAt)}`
    : "No Claude account can continue · sign in again in Settings › Accounts";
}

export function AccountsExhaustedRow({ block, workerId }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (request, fallback) => {
    setBusy(true);
    setError(null);
    const r = await request().catch(() => null);
    setBusy(false);
    if (!r?.ok) setError(failure(r, fallback));
  };
  const resume = (on) => run(() => api.setPlanResume(workerId, block.rowId, on), "Couldn't schedule it");
  const useKey = () => run(() => api.continueOnApiKey(workerId), "Couldn't switch to the API key");

  return (
    <div className="accounts-exhausted mono" role="status">
      <span>{exhaustedText(block)}</span>
      {!block.resumed && (block.nextResetAt || block.apiKey) && (
        <div className="accounts-exhausted__actions">
          {block.resumeAt ? (
            <>
              <span className="accounts-exhausted__note">Continuing at {clock(block.resumeAt)}</span>
              <button type="button" className="accounts-exhausted__btn is-quiet" onClick={() => resume(false)} disabled={busy}>Cancel</button>
            </>
          ) : block.nextResetAt ? (
            <button type="button" className="accounts-exhausted__btn" onClick={() => resume(true)} disabled={busy}>
              Resume at {clock(block.nextResetAt)}
            </button>
          ) : null}
          {block.apiKey && (
            <button type="button" className="accounts-exhausted__btn is-quiet" onClick={useKey} disabled={busy}>Use API key</button>
          )}
        </div>
      )}
      {error && <span className="acc-err" role="alert">{error}</span>}
    </div>
  );
}
