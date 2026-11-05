// Settings › Plugins — every plugin in ~/.eos/plugins: on/off, whether it's
// working, and a settings page generated from its manifest. Changes apply at
// once; there's nothing to restart. Add plugin installs one from npm, git or a
// folder (PluginInstall.jsx).

import { useEffect, useState, useSyncExternalStore } from "react";
import { CONTROLS, ToggleControl } from "./controls.jsx";
import { ensurePluginsLoaded, setPluginEnabled, setPluginSettings, usePlugins } from "../plugins/pluginsStore.js";
import { pluginFault, subscribePluginFaults } from "../plugins/faults.js";
import { notify } from "../lib/notify.js";
import { useSettings } from "../state/settings.jsx";
import { SettingsGroups } from "./SettingsGroups.jsx";
import { BUILTIN_PLUGIN_SETTINGS } from "./registry.jsx";
import { AddPluginPage, BackButton, PluginSourceRows, StagedReview } from "./PluginInstall.jsx";

const errText = (e) => (e instanceof Error ? e.message : String(e));

function usePluginFault(id) {
  const get = () => pluginFault(id);
  return useSyncExternalStore(subscribePluginFaults, get, get);
}

function PluginIcon({ manifest }) {
  // The manifest's own SVG; plugins are local code the user (or their agent) put here.
  if (manifest?.icon) return <span className="plg-icon" dangerouslySetInnerHTML={{ __html: manifest.icon }} />;
  return (
    <span className="plg-icon">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 3h6v4h3a2 2 0 0 1 2 2v3h-4v6h4v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1h4v-6H4V9a2 2 0 0 1 2-2h3z" />
      </svg>
    </span>
  );
}

function Status({ plugin }) {
  const fault = usePluginFault(plugin.id);
  if (plugin.state === "error") return <span className="plg-status is-err">Error</span>;
  if (fault) return <span className="plg-status is-err">Failed to load</span>;
  if (plugin.manifest?.experimental) return <span className="plg-status is-exp">Experimental</span>;
  return null;
}

async function toggle(plugin, on) {
  try {
    await setPluginEnabled(plugin.id, on);
  } catch (e) {
    notify.error(errText(e));
  }
}

function PluginRow({ plugin, onOpen }) {
  const name = plugin.manifest?.name ?? plugin.id;
  return (
    <div className="stg-row plg-row">
      <button type="button" className="plg-row__main" onClick={onOpen}>
        <PluginIcon manifest={plugin.manifest} />
        <span className="stg-row__text">
          <span className="stg-row__label">{name} <Status plugin={plugin} /></span>
          <span className="stg-row__desc">{plugin.manifest?.description ?? plugin.error ?? ""}</span>
        </span>
      </button>
      {plugin.manifest && <ToggleControl value={plugin.enabled} onChange={(v) => void toggle(plugin, v)} />}
    </div>
  );
}

function SettingControl({ def, value, onChange }) {
  if (def.type === "boolean") return <CONTROLS.toggle value={Boolean(value)} onChange={onChange} />;
  if (def.type === "select") return <CONTROLS.select value={value} onChange={onChange} options={def.options} />;
  if (def.type === "number") {
    if (def.min != null && def.max != null) {
      return <CONTROLS.slider value={value ?? def.min} onChange={onChange} min={def.min} max={def.max} step={def.step ?? 1} />;
    }
    return <CONTROLS.text value={value == null ? "" : String(value)} onChange={(v) => { const n = Number(v); if (v !== "" && Number.isFinite(n)) onChange(n); }} />;
  }
  if (def.multiline) return <CONTROLS.textarea value={value ?? ""} onChange={onChange} placeholder={def.placeholder} rows={4} />;
  return <CONTROLS.text value={value ?? ""} onChange={onChange} placeholder={def.placeholder} />;
}

function PluginPage({ plugin, onBack, onReview }) {
  const fault = usePluginFault(plugin.id);
  const defs = Object.entries(plugin.manifest?.settings ?? {});
  const save = async (key, value) => {
    try {
      await setPluginSettings(plugin.id, { [key]: value });
    } catch (e) {
      notify.error(errText(e));
    }
  };
  const problem = plugin.error ?? fault?.message ?? null;
  return (
    <>
      <BackButton onClick={onBack} />
      <div className="plg-head">
        <PluginIcon manifest={plugin.manifest} />
        <div>
          <h2 className="stg-title plg-head__title">{plugin.manifest?.name ?? plugin.id} <Status plugin={plugin} /></h2>
          {plugin.manifest?.description && <div className="stg-row__desc">{plugin.manifest.description}</div>}
        </div>
      </div>

      {problem && <pre className="plg-error">{problem}</pre>}

      <div className="stg-group">
        <div className="stg-group__title">Plugin</div>
        {plugin.manifest && (
          <div className="stg-row">
            <div className="stg-row__text">
              <div className="stg-row__label">Enabled</div>
              <div className="stg-row__desc">Turning it off removes everything it adds, at once.</div>
            </div>
            <ToggleControl value={plugin.enabled} onChange={(v) => void toggle(plugin, v)} />
          </div>
        )}
        {!plugin.builtin && (
          <div className="stg-row">
            <div className="stg-row__text">
              <div className="stg-row__label">Folder</div>
              <div className="stg-row__desc plg-mono">{plugin.dir}</div>
            </div>
            {plugin.manifest?.version && <span className="plg-mono plg-version">v{plugin.manifest.version}</span>}
          </div>
        )}
        {!plugin.builtin && <PluginSourceRows plugin={plugin} onReview={onReview} onRemoved={onBack} />}
      </div>

      {plugin.builtin && <BuiltinSettings id={plugin.id} />}

      {defs.length > 0 && (
        <div className="stg-group">
          <div className="stg-group__title">Settings</div>
          {defs.map(([key, def]) => (
            <div className={"stg-row" + (def.multiline ? " stg-row--stack" : "")} key={key}>
              <div className="stg-row__text">
                <div className="stg-row__label">{def.title}</div>
                {def.description && <div className="stg-row__desc">{def.description}</div>}
              </div>
              <SettingControl def={def} value={plugin.settings[key]} onChange={(v) => void save(key, v)} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// A built-in plugin's settings live where they always have (settings.json /
// config.json, settings/registry.jsx); its page just shows them.
function BuiltinSettings({ id }) {
  const { settings, setSetting } = useSettings();
  const groups = BUILTIN_PLUGIN_SETTINGS[id];
  return groups ? <SettingsGroups groups={groups} settings={settings} setSetting={setSetting} /> : null;
}

function Group({ title, plugins, onOpen }) {
  if (!plugins.length) return null;
  return (
    <div className="stg-group">
      <div className="stg-group__title">{title}</div>
      {plugins.map((p) => <PluginRow key={p.id} plugin={p} onOpen={() => onOpen(p.id)} />)}
    </div>
  );
}

export function PluginsSettings() {
  const plugins = usePlugins();
  const [openId, setOpenId] = useState(null);
  const [adding, setAdding] = useState(false);
  // An update fetched from a plugin's page, waiting for review.
  const [review, setReview] = useState(null);
  useEffect(() => { ensurePluginsLoaded(); }, []);

  const showPlugin = (id) => { setAdding(false); setReview(null); setOpenId(id); };
  if (review) return <StagedReview staged={review} onBack={() => setReview(null)} onInstalled={(p) => showPlugin(p.id)} />;
  if (adding) return <AddPluginPage onBack={() => setAdding(false)} onInstalled={showPlugin} />;
  const open = openId ? plugins.find((p) => p.id === openId) : null;
  if (open) return <PluginPage plugin={open} onBack={() => setOpenId(null)} onReview={setReview} />;

  const experimental = plugins.filter((p) => p.manifest?.experimental);
  const builtin = plugins.filter((p) => p.builtin && !p.manifest?.experimental);
  const installed = plugins.filter((p) => !p.builtin && !p.manifest?.experimental);
  return (
    <>
      <div className="plg-title-row">
        <h2 className="stg-title">Plugins</h2>
        <button type="button" className="m-btn m-btn--sm" onClick={() => setAdding(true)}>Add plugin</button>
      </div>
      <div className="stg-row__desc plg-intro">
        Plugins add to Eos’s own interface. Ask an agent for one (“add a clock to the top right”), add one from npm, git or a folder, or put a folder in <span className="plg-mono">~/.eos/plugins</span>. Changes show up at once.
      </div>
      <Group title="Built-in" plugins={builtin} onOpen={setOpenId} />
      <Group title="Installed" plugins={installed} onOpen={setOpenId} />
      <Group title="Experimental" plugins={experimental} onOpen={setOpenId} />
    </>
  );
}
