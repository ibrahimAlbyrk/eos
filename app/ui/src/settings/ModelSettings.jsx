// The Settings "Model" section. Same picker as the composer's new-spawn provider
// picker — both derive the provider list from providerChoices() and the model list
// from useProviderModels(), so the two are functionally identical. This persists
// the DEFAULT (model.provider + model.default) new agents launch on; the composer
// overrides it per-spawn.

import { useSettings } from "../state/settings.jsx";
import { providerChoices } from "../lib/backendCaps.js";
import { useProviderModels } from "../hooks/useProviderModels.js";
import { SelectControl } from "./controls.jsx";

// Defaults for the keys this section owns — merged into SETTING_DEFAULTS (the
// section renders a custom Component, so it has no `groups` items to derive from).
export const MODEL_SETTING_DEFAULTS = {
  "model.provider": "claude-sdk",
  "model.default": "opus",
};

export function ModelSettings() {
  const { settings, setSetting } = useSettings();
  const provider = settings["model.provider"];
  const model = settings["model.default"];

  const providerOpts = providerChoices().map((p) => ({ value: p.name, label: p.label }));
  const { models } = useProviderModels(provider);
  const modelOpts = models.map((m) => ({ value: m.id, label: m.name }));

  // Picking a provider defaults the model to a profile's pinned model (parity with
  // the composer pick); a bare subscription kind keeps the current Claude model.
  const onProvider = (name) => {
    setSetting("model.provider", name);
    const pinned = providerChoices().find((p) => p.name === name)?.model;
    if (pinned) setSetting("model.default", pinned);
  };

  return (
    <>
      <h2 className="stg-title">Model</h2>
      <div className="stg-group">
        <div className="stg-group__title">Provider</div>
        <div className="stg-row">
          <div className="stg-row__text">
            <div className="stg-row__label">Provider</div>
            <div className="stg-row__desc">Backend new agents launch on. Pick the model below.</div>
          </div>
          <SelectControl value={provider} options={providerOpts} onChange={onProvider} />
        </div>
      </div>
      <div className="stg-group">
        <div className="stg-group__title">Model</div>
        <div className="stg-row">
          <div className="stg-row__text">
            <div className="stg-row__label">Default model</div>
            <div className="stg-row__desc">New agents spawn with this model.</div>
          </div>
          <SelectControl value={model} options={modelOpts} onChange={(m) => setSetting("model.default", m)} />
        </div>
      </div>
    </>
  );
}
