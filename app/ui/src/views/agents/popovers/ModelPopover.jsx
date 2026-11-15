import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import {
  applyCatalog, applyProviders, getCatalogVersion, modelCommitId, modelsFor, subscribeCatalog,
} from "../../../lib/models.js";

const matchesModel = (current, model) =>
  current === model.id || model.aliases.includes(current);

export function ModelPopover({ live, worker }) {
  const ui = useUi();
  if (ui.openPopover !== "model") return null;
  return <ModelMenu live={live} ui={ui} worker={worker} />;
}

function ModelMenu({ live, ui, worker }) {
  const paneRef = useRef(null);
  // This pane's own worker (not the global selection) — the checkmark + the
  // setModel action must target THIS pane's agent, not the selected one.
  const selected = worker ?? null;
  const currentModel = selected?.model ?? ui.composer.model;
  const focused = selected ? selected.agent_role === "focused" : ui.composer.agentMode === "focused";
  useSyncExternalStore(subscribeCatalog, getCatalogVersion);
  const models = modelsFor(focused);
  const [active, setActive] = useState(() =>
    Math.max(0, models.findIndex((m) => matchesModel(currentModel, m))));

  useEffect(() => {
    paneRef.current?.focus();
    api.refreshModelCatalog().then(applyCatalog).catch(() => {});
    api.listProviders().then(applyProviders).catch(() => {});
  }, []);

  const pick = async (m) => {
    const id = modelCommitId(m);
    if (selected) await live.setModel(selected.id, id, selected.effort ?? ui.composer.effort);
    else ui.updateComposer({ model: id });
    ui.closeAllPops();
  };

  const onKeyDown = (e) => {
    let handled = true;
    if (e.key === "ArrowDown") setActive((i) => (i + 1) % models.length);
    else if (e.key === "ArrowUp") setActive((i) => (i - 1 + models.length) % models.length);
    else if (e.key === "Enter" && models[active]) pick(models[active]);
    else if (/^[1-9]$/.test(e.key) && models[Number(e.key) - 1]) pick(models[Number(e.key) - 1]);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  return (
    <div
      className="model-popover open"
      id="modelPopover"
      data-popover="model"
      ref={paneRef}
      tabIndex={-1}
      role="menu"
      onKeyDown={onKeyDown}
    >
      <div className="mp-head">Models</div>
      <div className="mp-scroll">
        {models.map((m, i) => {
          const on = matchesModel(currentModel, m);
          // A provider's models follow under its name once there is more than Claude.
          const group = m.provider && m.provider !== models[i - 1]?.provider ? m.provider : null;
          return (
            <Fragment key={m.id}>
            {group && <div className="mp-group">{group}</div>}
            <button
              className={"mp-row" + (on ? " on" : "") + (i === active ? " active" : "")}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(m)}
            >
              <span className="mp-name">{m.name}</span>
              {on && (
                <svg className="mp-check" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m2.5 8.5 3.5 3.5 7.5-8" />
                </svg>
              )}
              {i < 9 && <span className="mp-num">{i + 1}</span>}
            </button>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
