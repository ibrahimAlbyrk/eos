import { useUi } from "../../../state/ui.jsx";
import { MODELS, effortChoicesFor } from "../../../lib/models.js";

const matchesModel = (current, model) =>
  current === model.id || model.aliases.includes(current);

export function ModelPopover({ live }) {
  const ui = useUi();
  if (ui.openPopover !== "model") return null;
  const selected = live.workers.find((w) => w.id === ui.selectedId) ?? null;
  const currentModel = selected?.model ?? ui.composer.model;
  const currentEffort = selected?.effort ?? ui.composer.effort;
  const effortChoices = effortChoicesFor(currentModel);

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
        // Commit the family alias (claude CLI resolves "fable"/"opus"; the
        // curated short id like "fable-5" is display-only and 404s at the API)
        <button key={m.id} className={"mp-row" + (matchesModel(currentModel, m) ? " on" : "")} onClick={() => pickModel(m.aliases[0] ?? m.id)}>
          <span className="mp-name">{m.label}</span>
          <span className="mp-tag">{m.tag}</span>
        </button>
      ))}
      {effortChoices.length > 0 && (
        <>
          <div className="mp-divider"></div>
          <div className="mp-head">Thinking effort</div>
          <div className="mp-effort">
            {effortChoices.map((e) => (
              <button key={e.id} className={"mp-effort-btn" + (currentEffort === e.id ? " on" : "")} onClick={() => pickEffort(e.id)}>
                {e.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
