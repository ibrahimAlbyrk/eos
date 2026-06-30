import { useEffect, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { providerOptions, backendProfiles } from "../../../lib/backendCaps.js";
import { modelName } from "../../../lib/models.js";
import { api } from "../../../api/client.js";

// Provider switcher. Two distinct modes:
//   • a selected worker → live provider switch (the daemon stops + resumes the
//     session under the picked backend KIND, reusing the session id);
//   • the NEW-spawn composer → a two-level profile → model picker. Level 1 is the
//     configured backend PROFILES (config.backends); expanding one lazily fetches
//     that provider's available models (the Claude catalog for a subscription
//     profile, the provider's /v1/models for a metered one). Picking a model sets
//     backendProfile + model on the composer (the operator model override).
export function BackendPopover({ live }) {
  const ui = useUi();
  if (ui.openPopover !== "backend") return null;
  const selected = live.workers.find((w) => w.id === ui.selectedId) ?? null;
  return selected ? <BackendSwitchMenu live={live} ui={ui} selected={selected} /> : <SpawnBackendMenu ui={ui} />;
}

// Live provider switch for a running worker — the existing flat KIND list.
function BackendSwitchMenu({ live, ui, selected }) {
  const paneRef = useRef(null);
  const providers = providerOptions();
  const current = selected.backend_kind;
  const [active, setActive] = useState(() => Math.max(0, providers.findIndex((p) => p.value === current)));

  useEffect(() => { paneRef.current?.focus(); }, []);

  const pick = async (p) => {
    if (!p) { ui.closeAllPops(); return; }
    if (p.value !== current) await live.switchBackend(selected.id, p.value);
    ui.closeAllPops();
  };

  const onKeyDown = (e) => {
    let handled = true;
    if (e.key === "ArrowDown") setActive((i) => (i + 1) % providers.length);
    else if (e.key === "ArrowUp") setActive((i) => (i - 1 + providers.length) % providers.length);
    else if (e.key === "Enter" && providers[active]) pick(providers[active]);
    else if (/^[1-9]$/.test(e.key) && providers[Number(e.key) - 1]) pick(providers[Number(e.key) - 1]);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  return (
    <div className="model-popover glass-pop open" data-popover="backend" ref={paneRef} tabIndex={-1} role="menu" onKeyDown={onKeyDown}>
      <div className="mp-head">Provider</div>
      {providers.map((p, i) => (
        <button
          key={p.value}
          className={"mp-row" + (p.value === current ? " on" : "") + (i === active ? " active" : "")}
          onMouseEnter={() => setActive(i)}
          onClick={() => pick(p)}
        >
          <span className="mp-name">{p.label}</span>
          {p.value === current && <CheckIcon />}
          <span className="mp-num">{i + 1}</span>
        </button>
      ))}
    </div>
  );
}

// New-spawn two-level picker: configured profiles → that profile's models.
function SpawnBackendMenu({ ui }) {
  const paneRef = useRef(null);
  const profiles = backendProfiles();
  const currentProfile = ui.composer.backendProfile;
  const currentModel = ui.composer.model;
  // Start expanded on the picked profile, else the first one.
  const [expanded, setExpanded] = useState(currentProfile ?? profiles[0]?.name ?? null);
  // name -> { loading, models, error }
  const [modelsByName, setModelsByName] = useState({});
  // Names already fetched — dedupes across renders/re-expands without depending on
  // the (fresh-each-render) profiles array, which would otherwise re-fire the effect.
  const requested = useRef(new Set());

  useEffect(() => { paneRef.current?.focus(); }, []);

  // Lazily fetch the expanded profile's models once. The endpoint is fail-soft
  // (returns the pinned model + error on provider failure); we still default to the
  // profile's pinned model if it comes back empty, so the row is never a dead end.
  useEffect(() => {
    if (!expanded || requested.current.has(expanded)) return;
    requested.current.add(expanded);
    const pinned = backendProfiles().find((p) => p.name === expanded)?.model;
    setModelsByName((m) => ({ ...m, [expanded]: { loading: true, models: [], error: null } }));
    api.listBackendModels(expanded).then((res) => {
      const models = res.models?.length ? res.models : (pinned ? [pinned] : []);
      setModelsByName((m) => ({ ...m, [expanded]: { loading: false, models, error: res.error ?? null } }));
    });
  }, [expanded]);

  const toggleExpand = (name) => setExpanded((cur) => (cur === name ? null : name));

  const pickModel = (name, model) => {
    ui.updateComposer({ backendProfile: name, model, backendKind: null });
    ui.closeAllPops();
  };

  const onKeyDown = (e) => {
    if (e.key === "Escape") { ui.closeAllPops(); e.preventDefault(); e.stopPropagation(); }
  };

  return (
    <div className="model-popover glass-pop open" data-popover="backend" ref={paneRef} tabIndex={-1} role="menu" onKeyDown={onKeyDown}>
      <div className="mp-head">Provider</div>
      {profiles.map((p) => {
        const state = modelsByName[p.name];
        const isOpen = expanded === p.name;
        return (
          <div key={p.name} className="mp-group">
            <button
              className={"mp-row" + (p.name === currentProfile ? " on" : "")}
              onClick={() => toggleExpand(p.name)}
            >
              <span className="mp-name">{p.name}</span>
              {p.name === currentProfile && <CheckIcon />}
              <span className="mp-num">{isOpen ? "▾" : "▸"}</span>
            </button>
            {isOpen && (
              <div className="mp-models">
                {state?.loading && <div className="mp-sub mp-muted">Loading models…</div>}
                {!state?.loading && (state?.models ?? []).map((m) => {
                  const on = p.name === currentProfile && m === currentModel;
                  return (
                    <button key={m} className={"mp-row mp-sub" + (on ? " on" : "")} onClick={() => pickModel(p.name, m)}>
                      <span className="mp-name">{modelName(m) || m}</span>
                      {on && <CheckIcon />}
                    </button>
                  );
                })}
                {!state?.loading && state?.error && <div className="mp-sub mp-muted mp-err">{state.error}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function CheckIcon() {
  return (
    <svg className="mp-check" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m2.5 8.5 3.5 3.5 7.5-8" />
    </svg>
  );
}
