import { useUi } from "../../../state/ui.jsx";
import { MODELS, EFFORTS } from "../../../lib/models.js";

const matchesModel = (current, model) =>
  current === model.id || model.aliases.includes(current);

export function ModelPopover({ live }) {
  const ui = useUi();
  if (ui.openPopover !== "model") return null;
  const selected = live.workers.find((w) => w.id === ui.selectedId) ?? null;
  const currentModel = selected?.model ?? ui.composer.model;
  const currentEffort = selected?.effort ?? ui.composer.effort;

  const pickModel = async (id) => {
    if (selected) await live.setModel(selected.id, id, currentEffort);
    else ui.updateComposer({ model: id });
  };
  const pickEffort = async (id) => {
    if (selected) await live.setModel(selected.id, currentModel, id);
    else ui.updateComposer({ effort: id });
  };

  return (
    <div className="model-popover glass-pop open" id="modelPopover" data-popover="model">
      <div className="mp-head">Model</div>
      {MODELS.map((m) => (
        <button key={m.id} className={"mp-row" + (matchesModel(currentModel, m) ? " on" : "")} onClick={() => pickModel(m.id)}>
          <span className="mp-name">{m.label}</span>
          <span className="mp-tag">{m.tag}</span>
        </button>
      ))}
      <div className="mp-divider"></div>
      <div className="mp-head">Thinking effort</div>
      <div className="mp-effort">
        {EFFORTS.map((e) => (
          <button key={e.id} className={"mp-effort-btn" + (currentEffort === e.id ? " on" : "")} onClick={() => pickEffort(e.id)}>
            {e.label}
          </button>
        ))}
      </div>
    </div>
  );
}
