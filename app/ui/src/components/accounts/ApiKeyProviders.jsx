// The API-key-only providers (no subscription product) as a row of tiles; a tile
// opens its key editor underneath the row.

import { useState } from "react";
import { removeApiKey } from "../../state/accountsStore.js";
import { ProviderGlyph } from "./ProviderGlyph.jsx";
import { ApiKeyField } from "./ApiKeyField.jsx";
import { metaFor } from "./providerMeta.js";

export function ApiKeyProviders({ accounts }) {
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const current = accounts.find((a) => a.id === openId) ?? null;

  const toggle = (id) => {
    setError(null);
    setOpenId((v) => (v === id ? null : id));
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    const r = await removeApiKey(current);
    setBusy(false);
    if (r.ok) setOpenId(null);
    else setError(r.error);
  };

  return (
    <section className="acc-keys">
      <div className="acc-section-head">
        <h3>API key providers</h3>
        <span>Metered — billed by each provider</span>
      </div>
      <div className="acc-tiles">
        {accounts.map((a) => (
          <button
            key={a.id}
            type="button"
            className={"acc-tile" + (a.id === openId ? " is-open" : "")}
            aria-expanded={a.id === openId}
            onClick={() => toggle(a.id)}
          >
            <ProviderGlyph id={a.id} size={28} />
            <span className="acc-tile__names">
              <b>{metaFor(a).name}</b>
              {a.apiKey.set
                ? <small className="is-ok"><span className="acc-dot is-ok" />Key saved</small>
                : <small>Add key</small>}
            </span>
          </button>
        ))}
      </div>
      {current && (
        <div className="acc-keyedit">
          <div className="acc-keyedit__head">
            <ProviderGlyph id={current.id} size={24} />
            <b>{current.apiKey.set ? `Replace the ${metaFor(current).name} key` : `Add a ${metaFor(current).name} key`}</b>
            {current.apiKey.set && (
              <button type="button" className="acc-btn acc-btn--ghost acc-btn--danger" onClick={remove} disabled={busy}>Remove key</button>
            )}
          </div>
          <ApiKeyField key={current.id} account={current} autoFocus onDone={() => setOpenId(null)} onCancel={() => setOpenId(null)} />
          {error && <div className="acc-err" role="alert">{error}</div>}
        </div>
      )}
    </section>
  );
}
