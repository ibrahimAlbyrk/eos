// Provider-management panel — the Settings "Model" tab. Lists supported providers,
// lets the user pick one, enter an API key, and Save — which FIRST tests the
// connection, then on success adds the provider so it appears in the composer's
// provider picker; on failure shows a clear warning and does NOT add it.
//
// Already-configured providers appear with a remove action.

import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { applyDescriptors, applyProfiles, providerChoices } from "../lib/backendCaps.js";

// Defaults for the keys this section owns — merged into SETTING_DEFAULTS (the
// section renders a custom Component, so it has no `groups` items to derive from).
// Kept here so the registry + composer spawn defaults still work even though the
// Model tab no longer surfaces these pickers visually.
export const MODEL_SETTING_DEFAULTS = {
  "model.provider": "claude-sdk",
  "model.default": "opus",
};

// ---------------------------------------------------------------------------
// small local icons (consistent with the app's mono-line stroke style)
// ---------------------------------------------------------------------------

const PlusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <path d="M8 3v10M3 8h10" />
  </svg>
);

const TrashIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 5h10M6 5V3.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V5M5 5v7.5a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V5M6.5 8v3M9.5 8v3" />
  </svg>
);

const CheckIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 8.5l3.5 3.5L13 5" />
  </svg>
);

const Spinner = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <path d="M8 2a6 6 0 1 0 6 6" strokeOpacity="0.4" />
    <path d="M8 2a6 6 0 0 1 6 6" strokeDasharray="9 28" className="stg-spin" />
    <style>{`.stg-spin{transform-origin:8px 8px;animation:stg-spin 0.7s linear infinite}@keyframes stg-spin{to{transform:rotate(360deg)}}`}</style>
  </svg>
);

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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// A short hint for a preset: base host + default model.
// The operator's own metered profiles (excludes subscription lanes).
function meteredProfiles() {
  return providerChoices().filter(c => !c.subscription).map(c => ({ name: c.name, kind: c.kind, model: c.model, label: c.label }));
}

function presetHint(preset) {
  if (!preset) return "";
  try { const u = new URL(preset.baseUrl); return `${u.hostname}  ·  ${preset.defaultModel}`; } catch { return preset.baseUrl; }
}

async function refreshUiConfig() {
  try {
    const cfg = await api.uiConfig();
    if (!cfg) return;
    applyDescriptors(cfg.backends);
    applyProfiles(cfg.backendProfiles);
  } catch { /* silent — poll will recover */ }
}

// ---------------------------------------------------------------------------
// main component
// ---------------------------------------------------------------------------

export function ModelSettings() {
  const [presets, setPresets] = useState([]);
  const [configured, setConfigured] = useState(() => meteredProfiles());
  const [expanded, setExpanded] = useState(null); // preset id being configured, or null
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState(null);
  const [adding, setAdding] = useState(false); // true while the ADD call is in flight
  const [justAdded, setJustAdded] = useState(null); // preset id that was just saved
  const [removing, setRemoving] = useState(null); // profile name being removed

  useEffect(() => {
    api.listBackendPresets().then(setPresets);
  }, []);

  const startAdd = (presetId) => {
    setExpanded(presetId);
    setApiKey("");
    setShowKey(false);
    setTestError(null);
    setJustAdded(null);
    setAdding(false);
  };

  const cancelAdd = () => {
    setExpanded(null);
    setApiKey("");
    setTestError(null);
    setJustAdded(null);
    setAdding(false);
  };

  const doSave = async () => {
    const preset = presets.find(p => p.id === expanded);
    if (!preset || !apiKey.trim()) return;
    setTestError(null);
    setTesting(true);
    setAdding(false);

    // Step 1 — test connection ephemerally (NO persistence).
    const testRes = await api.testBackend({ preset: preset.id, apiKey: apiKey.trim() });
    setTesting(false);

    if (!testRes.ok || !testRes.body?.ok) {
      const err = testRes.body?.error ?? `test failed (HTTP ${testRes.status})`;
      setTestError(err);
      return;
    }

    // Step 2 — add the provider for real.
    setAdding(true);
    const addRes = await api.addBackend({ name: preset.id, preset: preset.id, apiKey: apiKey.trim() });
    setAdding(false);

    if (!addRes.ok) {
      setTestError(addRes.body?.error ?? `add failed (HTTP ${addRes.status})`);
      return;
    }

    // Success — refresh ui-config so the composer picker sees it.
    setJustAdded(preset.id);
    setApiKey("");
    await refreshUiConfig();
    // Update the local configured list so the Settings tab reflects it.
    setConfigured(meteredProfiles());
  };

  const doRemove = async (name) => {
    setRemoving(name);
    const res = await api.deleteBackend(name);
    if (res.ok) {
      await refreshUiConfig();
      setConfigured(meteredProfiles());
    }
    setRemoving(null);
  };

  const isConfigured = (presetId) => configured.some(p => p.name === presetId);

  // Provider list: configured ones first, then remaining available presets.
  const availablePresets = presets.filter(p => !isConfigured(p.id));

  return (
    <>
      <h2 className="stg-title">Providers</h2>

      {/* ------------- configured ------------- */}
      {configured.length > 0 && (
        <div className="stg-group">
          <div className="stg-group__title">Configured</div>
          {configured.map((p) => {
            const preset = presets.find(pr => pr.id === p.name);
            const label = preset?.label ?? p.name;
            const hint = presetHint(preset) || p.kind;
            const busy = removing === p.name;
            return (
              <div className="stg-row" key={p.name}>
                <div className="stg-row__text">
                  <div className="stg-row__label">{label}</div>
                  <div className="stg-row__desc">{hint}</div>
                </div>
                <button
                  type="button"
                  className="stg-prov-rm"
                  disabled={busy}
                  title={busy ? "Removing…" : `Remove ${label}`}
                  onClick={() => doRemove(p.name)}
                >
                  {busy ? <Spinner /> : <TrashIcon />}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* ------------- available presets ------------- */}
      <div className="stg-group">
        <div className="stg-group__title">Add a provider</div>

        {availablePresets.length === 0 && configured.length > 0 && (
          <div className="stg-empty">All providers are configured.</div>
        )}
        {availablePresets.length === 0 && configured.length === 0 && (
          <div className="stg-empty">Loading providers…</div>
        )}

        {availablePresets.map((preset) => {
          const isOpen = expanded === preset.id;
          const busy = isOpen && (testing || adding);
          const ok = justAdded === preset.id;

          return (
            <div key={preset.id}>
              <div className="stg-row">
                <div className="stg-row__text">
                  <div className="stg-row__label">{preset.label}</div>
                  <div className="stg-row__desc">{presetHint(preset)}</div>
                </div>
                {ok ? (
                  <span className="stg-prov-ok"><CheckIcon /></span>
                ) : isOpen ? (
                  <button type="button" className="stg-prov-cancel" onClick={cancelAdd}>
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    className="stg-prov-add"
                    title={`Add ${preset.label}`}
                    onClick={() => startAdd(preset.id)}
                  >
                    <PlusIcon />
                  </button>
                )}
              </div>

              {/* expanded key-entry row */}
              {isOpen && (
                <div className="stg-row stg-row--stack" style={{ paddingTop: 4, paddingBottom: 10 }}>
                  {/* Key input */}
                  <div className={`stg-input${testError ? " stg-input--err" : ""}`} style={{ minWidth: "100%" }}>
                    <input
                      type={showKey ? "text" : "password"}
                      value={apiKey}
                      placeholder="Paste your API key…"
                      spellCheck={false}
                      autoComplete="new-password"
                      disabled={busy || ok}
                      onChange={(e) => { setApiKey(e.target.value); setTestError(null); setJustAdded(null); }}
                      onKeyDown={(e) => { if (e.key === "Enter" && !busy && !ok) doSave(); }}
                    />
                    <button
                      type="button"
                      className="stg-input__eye"
                      title={showKey ? "Hide" : "Show"}
                      onClick={() => setShowKey((v) => !v)}
                    >
                      {showKey ? <EyeOffIcon /> : <EyeIcon />}
                    </button>
                  </div>

                  {/* Error warning */}
                  {testError && (
                    <div className="stg-prov-err">{testError}</div>
                  )}

                  {/* Save button */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <button
                      type="button"
                      className="stg-prov-save"
                      disabled={busy || ok || !apiKey.trim()}
                      onClick={doSave}
                    >
                      {testing ? <><Spinner /> Testing…</> : adding ? <><Spinner /> Saving…</> : "Test & Save"}
                    </button>
                    {ok && (
                      <span style={{ fontSize: "var(--text-sm)", color: "var(--ok)", display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <CheckIcon /> Added — available in new conversations
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
