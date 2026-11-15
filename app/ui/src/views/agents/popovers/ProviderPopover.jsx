import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useUi } from "../../../state/ui.jsx";
import { useSettings } from "../../../state/settings.jsx";
import { api } from "../../../api/client.js";
import {
  applyProviders, getCatalogVersion, modelCommitId, modelsOfProvider, providerNames, providerOf, subscribeCatalog,
} from "../../../lib/models.js";

// The provider of a focused chat: Claude or another signed-in one. Picking a
// provider puts the chat on that provider's first model; the model menu then
// lists that provider's models. A running chat moves there with its
// conversation.
export function ProviderPopover({ live, worker }) {
  const ui = useUi();
  if (ui.openPopover !== "provider") return null;
  return <ProviderMenu live={live} ui={ui} worker={worker ?? null} />;
}

function ProviderMenu({ live, ui, worker }) {
  const paneRef = useRef(null);
  const { openSettings } = useSettings();
  useSyncExternalStore(subscribeCatalog, getCatalogVersion);
  const names = providerNames();
  const current = providerOf(worker?.model ?? ui.composer.model);
  const [active, setActive] = useState(() => Math.max(0, names.indexOf(current)));

  useEffect(() => {
    paneRef.current?.focus();
    // A sign-in made since the app opened brings its provider.
    api.listProviders().then(applyProviders).catch(() => {});
  }, []);

  const pick = async (name) => {
    const first = name === current ? null : modelsOfProvider(name)[0];
    ui.closeAllPops();
    if (!first) return;
    const id = modelCommitId(first);
    if (worker) await live.setModel(worker.id, id, worker.effort ?? ui.composer.effort);
    else ui.updateComposer({ model: id });
  };

  const onKeyDown = (e) => {
    let handled = true;
    if (e.key === "ArrowDown") setActive((i) => (i + 1) % names.length);
    else if (e.key === "ArrowUp") setActive((i) => (i - 1 + names.length) % names.length);
    else if (e.key === "Enter" && names[active]) pick(names[active]);
    else if (/^[1-9]$/.test(e.key) && names[Number(e.key) - 1]) pick(names[Number(e.key) - 1]);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  return (
    <div className="model-popover mp-accounts open" data-popover="provider" ref={paneRef} tabIndex={-1} role="menu" onKeyDown={onKeyDown}>
      <div className="mp-head">Provider</div>
      <div className="mp-scroll">
        {names.map((name, i) => (
          <button
            key={name}
            className={"mp-row" + (name === current ? " on" : "") + (i === active ? " active" : "")}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(name)}
          >
            <span className="mp-name">{name}</span>
            {name === current && (
              <svg className="mp-check" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m2.5 8.5 3.5 3.5 7.5-8" />
              </svg>
            )}
            <span className="mp-num">{i + 1}</span>
          </button>
        ))}
      </div>
      <div className="mp-sep" />
      <button className="mp-row mp-manage" onClick={() => { ui.closeAllPops(); openSettings("accounts"); }}>
        <span className="mp-name">Manage accounts…</span>
      </button>
    </div>
  );
}
