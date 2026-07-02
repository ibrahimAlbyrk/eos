import { useEffect, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { providerChoices, providerName, providerSwitchTargets } from "../../../lib/backendCaps.js";
import { modelName } from "../../../lib/models.js";
import { useProviderModels } from "../../../hooks/useProviderModels.js";

// Provider switcher. Two distinct modes:
//   • a selected worker → live provider switch (the daemon stops + resumes the
//     session under the picked backend KIND, reusing the session id);
//   • the NEW-spawn composer → the unified provider picker over providerChoices()
//     (subscription kinds + the operator's configured API profiles). Picking one
//     sets composer.provider + defaults the model to a profile's pinned model. The
//     model itself is chosen from the SEPARATE model pill — the Claude catalog
//     (ModelPopover) for a subscription provider, this SpawnModelPopover for an API
//     profile.
export function BackendPopover({ live, worker }) {
  const ui = useUi();
  if (ui.openPopover !== "backend") return null;
  // This pane's own worker (not the global selection) — the switch targets +
  // action must apply to THIS pane's agent, not the selected one.
  const selected = worker ?? null;
  return selected ? <BackendSwitchMenu live={live} ui={ui} selected={selected} /> : <SpawnBackendMenu ui={ui} />;
}

// Live provider switch for a running worker — the SAME configured providers as the
// new-spawn picker (providerSwitchTargets over providerChoices), never a raw kind.
// Targets the daemon can't hand off to (a different conversation store) are greyed
// with the reason; the switch routes by the choice's backend kind.
function BackendSwitchMenu({ live, ui, selected }) {
  const paneRef = useRef(null);
  const targets = providerSwitchTargets(selected.backend_kind);
  const [active, setActive] = useState(() => Math.max(0, targets.findIndex((p) => p.current)));

  useEffect(() => { paneRef.current?.focus(); }, []);

  const pick = async (p) => {
    if (!p || p.disabled) return;
    if (!p.current) await live.switchBackend(selected.id, p.kind);
    ui.closeAllPops();
  };

  const onKeyDown = (e) => {
    let handled = true;
    if (e.key === "ArrowDown") setActive((i) => (i + 1) % targets.length);
    else if (e.key === "ArrowUp") setActive((i) => (i - 1 + targets.length) % targets.length);
    else if (e.key === "Enter" && targets[active]) pick(targets[active]);
    else if (/^[1-9]$/.test(e.key) && targets[Number(e.key) - 1]) pick(targets[Number(e.key) - 1]);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  return (
    <div className="model-popover glass-pop open" data-popover="backend" ref={paneRef} tabIndex={-1} role="menu" onKeyDown={onKeyDown}>
      <div className="mp-head">Provider</div>
      <div className="mp-scroll">
        {targets.map((p, i) => (
          <button
            key={p.name}
            className={"mp-row" + (p.current ? " on" : "") + (i === active ? " active" : "") + (p.disabled ? " disabled" : "")}
            disabled={p.disabled}
            title={p.disabled ? p.reason : undefined}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(p)}
          >
            <span className="mp-name">{providerName(p)}</span>
            {p.current && <CheckIcon />}
            <span className="mp-num">{i + 1}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// New-spawn provider picker over providerChoices(). Picking one sets
// composer.provider (resolved to backendKind/backendProfile at spawn) and defaults
// the model to a profile's pinned model; the model is then refined from the
// separate model pill.
function SpawnBackendMenu({ ui }) {
  const paneRef = useRef(null);
  const choices = providerChoices();
  const current = ui.composer.provider;
  const [active, setActive] = useState(() => Math.max(0, choices.findIndex((p) => p.name === current)));

  useEffect(() => { paneRef.current?.focus(); }, []);

  const pick = (p) => {
    const patch = { provider: p.name };
    if (p.model) patch.model = p.model; // a profile's pinned model becomes the default
    ui.updateComposer(patch);
    ui.closeAllPops();
  };

  const onKeyDown = (e) => {
    let handled = true;
    if (e.key === "ArrowDown") setActive((i) => (i + 1) % choices.length);
    else if (e.key === "ArrowUp") setActive((i) => (i - 1 + choices.length) % choices.length);
    else if (e.key === "Enter" && choices[active]) pick(choices[active]);
    else if (/^[1-9]$/.test(e.key) && choices[Number(e.key) - 1]) pick(choices[Number(e.key) - 1]);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  return (
    <div className="model-popover glass-pop open" data-popover="backend" ref={paneRef} tabIndex={-1} role="menu" onKeyDown={onKeyDown}>
      <div className="mp-head">Provider</div>
      <div className="mp-scroll">
        {choices.map((p, i) => (
          <button
            key={p.name}
            className={"mp-row" + (p.name === current ? " on" : "") + (i === active ? " active" : "")}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(p)}
          >
            <span className="mp-name">{providerName(p)}</span>
            {p.name === current && <CheckIcon />}
            <span className="mp-num">{i + 1}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// New-spawn model picker for an API-profile provider. Lazily fetches that
// provider's /v1/models (useProviderModels), fail-soft to its pinned model so the
// list is never a dead end. A subscription provider uses the Claude ModelPopover
// instead, never this. Picking a model sets the composer model override.
export function SpawnModelPopover() {
  const ui = useUi();
  if (ui.openPopover !== "spawnModel") return null;
  return <SpawnModelMenu ui={ui} />;
}

function SpawnModelMenu({ ui }) {
  const paneRef = useRef(null);
  const currentModel = ui.composer.model;
  const { loading, models, error } = useProviderModels(ui.composer.provider);
  const [active, setActive] = useState(0);

  useEffect(() => { paneRef.current?.focus(); }, []);

  const pick = (m) => {
    ui.updateComposer({ model: m });
    ui.closeAllPops();
  };

  const onKeyDown = (e) => {
    let handled = true;
    if (e.key === "Escape") ui.closeAllPops();
    else if (!models.length) handled = false;
    else if (e.key === "ArrowDown") setActive((i) => (i + 1) % models.length);
    else if (e.key === "ArrowUp") setActive((i) => (i - 1 + models.length) % models.length);
    else if (e.key === "Enter" && models[active]) pick(models[active].id);
    else if (/^[1-9]$/.test(e.key) && models[Number(e.key) - 1]) pick(models[Number(e.key) - 1].id);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  return (
    <div className="model-popover glass-pop open" data-popover="spawnModel" ref={paneRef} tabIndex={-1} role="menu" onKeyDown={onKeyDown}>
      <div className="mp-head">Model</div>
      <div className="mp-scroll">
        {loading && <div className="mp-sub mp-muted">Loading models…</div>}
        {!loading && models.map((m, i) => {
          const on = m.id === currentModel;
          return (
            <button
              key={m.id}
              className={"mp-row" + (on ? " on" : "") + (i === active ? " active" : "")}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(m.id)}
            >
              <span className="mp-name">{m.name || modelName(m.id) || m.id}</span>
              {on && <CheckIcon />}
              <span className="mp-num">{i + 1}</span>
            </button>
          );
        })}
        {!loading && error && <div className="mp-sub mp-muted mp-err">{error}</div>}
      </div>
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
