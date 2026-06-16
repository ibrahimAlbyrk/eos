import { useEffect, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { MODELS } from "../../../lib/models.js";

const matchesModel = (current, model) =>
  current === model.id || model.aliases.includes(current);

export function ModelPopover({ live }) {
  const ui = useUi();
  if (ui.openPopover !== "model") return null;
  return <ModelMenu live={live} ui={ui} />;
}

function ModelMenu({ live, ui }) {
  const paneRef = useRef(null);
  const selected = live.workers.find((w) => w.id === ui.selectedId) ?? null;
  const currentModel = selected?.model ?? ui.composer.model;
  const [active, setActive] = useState(() =>
    Math.max(0, MODELS.findIndex((m) => matchesModel(currentModel, m))));

  useEffect(() => { paneRef.current?.focus(); }, []);

  const pick = async (m) => {
    // Commit the family alias (claude CLI resolves "fable"/"opus"; the
    // curated short id like "fable-5" is display-only and 404s at the API)
    const id = m.aliases[0] ?? m.id;
    if (selected) await live.setModel(selected.id, id, selected.effort ?? ui.composer.effort);
    else ui.updateComposer({ model: id });
    ui.closeAllPops();
  };

  const onKeyDown = (e) => {
    let handled = true;
    if (e.key === "ArrowDown") setActive((i) => (i + 1) % MODELS.length);
    else if (e.key === "ArrowUp") setActive((i) => (i - 1 + MODELS.length) % MODELS.length);
    else if (e.key === "Enter" && MODELS[active]) pick(MODELS[active]);
    else if (/^[1-9]$/.test(e.key) && MODELS[Number(e.key) - 1]) pick(MODELS[Number(e.key) - 1]);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  return (
    <div
      className="model-popover glass-pop open"
      id="modelPopover"
      data-popover="model"
      ref={paneRef}
      tabIndex={-1}
      role="menu"
      onKeyDown={onKeyDown}
    >
      <div className="mp-head">Models</div>
      {MODELS.map((m, i) => {
        const on = matchesModel(currentModel, m);
        return (
          <button
            key={m.id}
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
            <span className="mp-num">{i + 1}</span>
          </button>
        );
      })}
    </div>
  );
}
