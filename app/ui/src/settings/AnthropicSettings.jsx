// Anthropic credentials panel — the Settings "Anthropic" tab. Two masked inputs
// (OAuth token + API key) that feed ONLY the in-process Claude SDK sessions; the
// claude-cli (terminal) lane is untouched. Priority when both are set: the OAuth
// token wins (exported as CLAUDE_CODE_OAUTH_TOKEN, which sidesteps the SDK's
// mid-session token refresh); the API key applies only when no OAuth token is set.
//
// The daemon never echoes the raw secrets back: getAnthropicConfig returns only a
// redacted { apiKeySet, authTokenSet }, so the inputs start empty and a saved field
// shows a "(saved)" placeholder. A blank Save (via Clear) removes that field.
//
// Custom Component (no registry `groups`), like ModelSettings/RemoteSettings — it
// owns no settings.json keys (config.anthropic lives in config.json).

import { useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";

export const ANTHROPIC_SETTING_DEFAULTS = {};

const EyeIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const EyeOffIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="3" />
    <path d="M4 4l16 16" />
  </svg>
);

function CredentialRow({ label, desc, placeholder, isSet, onSave }) {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const dirty = value.trim().length > 0;

  const commit = async (next) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const r = await onSave(next);
      if (!r.ok) {
        setError(r.body?.error ?? `save failed (HTTP ${r.status})`);
        return;
      }
      setValue("");
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stg-row stg-row--stack">
      <div className="stg-row__text">
        <div className="stg-row__label">{label}</div>
        <div className="stg-row__desc">{desc}</div>
      </div>

      <div className={`stg-input${error ? " stg-input--err" : ""}`} style={{ minWidth: "100%" }}>
        <input
          type={show ? "text" : "password"}
          value={value}
          placeholder={isSet ? "•••••••••••••• (saved)" : placeholder}
          spellCheck={false}
          autoComplete="new-password"
          disabled={busy}
          onChange={(e) => { setValue(e.target.value); setError(null); setSaved(false); }}
          onKeyDown={(e) => { if (e.key === "Enter" && dirty && !busy) commit(value.trim()); }}
        />
        <button
          type="button"
          className="stg-input__eye"
          title={show ? "Hide" : "Show"}
          onClick={() => setShow((v) => !v)}
        >
          {show ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>

      {error && <div className="stg-prov-err">{error}</div>}

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button type="button" className="stg-prov-save" disabled={busy || !dirty} onClick={() => commit(value.trim())}>
          {busy ? "Saving…" : "Save"}
        </button>
        {isSet && !dirty && (
          <button
            type="button"
            disabled={busy}
            onClick={() => commit("")}
            style={{ background: "none", border: "none", color: "var(--fg-dim)", cursor: "pointer", fontSize: 12, textDecoration: "underline" }}
          >
            Clear
          </button>
        )}
        {saved && <span className="stg-row__desc">Saved.</span>}
      </div>
    </div>
  );
}

export function AnthropicSettings() {
  const [status, setStatus] = useState({ apiKeySet: false, authTokenSet: false });
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    api.getAnthropicConfig().then((s) => { if (s) setStatus(s); }).catch(() => {});
  }, []);

  // Persist a single field; the redacted response carries the new set-state.
  const save = async (patch) => {
    const r = await api.setAnthropicConfig(patch);
    if (r.ok && r.body) setStatus(r.body);
    return r;
  };

  return (
    <>
      <h2 className="stg-title">Anthropic</h2>

      <div className="stg-group">
        <div className="stg-group__title">Claude SDK credentials</div>

        <div className="stg-row stg-row--stack">
          <div className="stg-row__desc">
            Used only by the in-process Claude SDK sessions. If both are set, the OAuth
            token takes precedence. The claude-cli (terminal) lane is unaffected.
          </div>
        </div>

        <CredentialRow
          label="OAuth token"
          desc="A claude setup-token, exported as CLAUDE_CODE_OAUTH_TOKEN. Preferred — avoids the SDK's mid-session token refresh."
          placeholder="Paste your OAuth token…"
          isSet={status.authTokenSet}
          onSave={(v) => save({ authToken: v })}
        />

        <CredentialRow
          label="API key"
          desc="An Anthropic API key, exported as ANTHROPIC_API_KEY. Used only when no OAuth token is set; bills the metered API."
          placeholder="Paste your API key…"
          isSet={status.apiKeySet}
          onSave={(v) => save({ apiKey: v })}
        />
      </div>
    </>
  );
}
