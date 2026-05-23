import { useUi } from "../../state/ui.jsx";

const MODELS = [
  { id: "haiku-4.5",  label: "haiku-4.5",  tag: "fastest" },
  { id: "sonnet-4.5", label: "sonnet-4.5", tag: "balanced" },
  { id: "opus-4.7",   label: "opus-4.7",   tag: "most capable" },
];

const EFFORTS = [
  { id: "low",       label: "Low" },
  { id: "medium",    label: "Medium" },
  { id: "high",      label: "High" },
  { id: "extrahigh", label: "Extra high" },
];

export function ModelPopover({ live }) {
  const ui = useUi();
  if (ui.openPopover !== "model") return null;
  const draft = ui.drafts.get(ui.selectedId);
  const selected = !draft ? live.workers.find((w) => w.id === ui.selectedId) : null;
  const currentModel = selected?.model ?? draft?.model ?? ui.composer.model;
  const currentEffort = selected?.effort ?? draft?.effort ?? ui.composer.effort;

  const pickModel = async (id) => {
    if (selected) await live.setModel(selected.id, id, currentEffort);
    else if (draft) ui.updateDraft(ui.selectedId, { model: id });
    else ui.updateComposer({ model: id });
  };
  const pickEffort = async (id) => {
    if (selected) await live.setModel(selected.id, currentModel, id);
    else if (draft) ui.updateDraft(ui.selectedId, { effort: id });
    else ui.updateComposer({ effort: id });
  };

  return (
    <div className="model-popover glass-pop open" id="modelPopover" data-popover="model">
      <div className="mp-head">Model</div>
      {MODELS.map((m) => (
        <button key={m.id} className={"mp-row" + (currentModel === m.id ? " on" : "")} onClick={() => pickModel(m.id)}>
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
