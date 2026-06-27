// Graph-LEVEL settings, separate from any node's config: name, description, the
// standing expert pool (experts[]) and the run-args shape (argsSchema). These are
// fields of WorkflowGraphSchema, saved with the graph via PUT. Shown in the right
// rail when no node is selected. Like the node inspector, every enum (expert
// model/effort, expert `from`) is a SELECTOR; only id/prompt are free text.
import { Field, Select, Segmented, TextInput, TextArea } from "./inspectorControls.jsx";
import { JsonField } from "./JsonField.jsx";
import { effortChoicesFor } from "../../../lib/models.js";
import { EFFORT_LEVELS } from "./nodeConfigSchemas.js";

function effortOptions(model) {
  return (effortChoicesFor(model) || []).filter((e) => EFFORT_LEVELS.includes(e.id)).map((e) => ({ value: e.id, label: e.label }));
}

function ExpertRow({ expert, index, workerDefs, modelOptions, onChange, onRemove }) {
  const set = (patch) => onChange(index, { ...expert, ...patch });
  return (
    <div className="wfe-subform">
      <div className="wfe-subform__head">
        <span className="wfe-field__label">Expert {index + 1}</span>
        <button type="button" className="wfe-mini-btn wfe-mini-btn--danger" onClick={() => onRemove(index)}>remove</button>
      </div>
      <Field label="Id (peer slug)" required>
        <TextInput value={expert.id} onChange={(v) => set({ id: v })} placeholder="solid-expert" mono />
      </Field>
      <Field label="From (worker def)">
        <Select value={expert.from} options={(workerDefs || []).map((d) => ({ value: d.name, label: d.name, tag: d.source }))} onChange={(v) => set({ from: v })} placeholder="general-purpose" />
      </Field>
      <Field label="Prompt" required>
        <TextArea value={expert.prompt} onChange={(v) => set({ prompt: v })} rows={2} placeholder="Standing directive — stay IDLE-but-consultable…" />
      </Field>
      <Field label="Model">
        <Select value={expert.model} options={modelOptions} onChange={(v) => set({ model: v })} />
      </Field>
      <Field label="Effort">
        <Segmented value={expert.effort} options={effortOptions(expert.model)} onChange={(v) => set({ effort: v })} clearable />
      </Field>
    </div>
  );
}

export function GraphMetaPanel({ graph, onSetMeta, workerDefs, modelOptions }) {
  const experts = graph.experts || [];
  const setExperts = (next) => onSetMeta({ experts: next.length ? next : undefined });

  return (
    <div className="wfe-meta">
      <div className="wfe-inspector__header">
        <span className="wfe-inspector__title">Graph settings</span>
      </div>

      <Field label="Name"><TextInput value={graph.name || ""} onChange={(v) => onSetMeta({ name: v })} /></Field>
      <Field label="Description"><TextArea value={graph.description || ""} onChange={(v) => onSetMeta({ description: v })} rows={2} /></Field>

      <div className="wfe-insp__section">
        <div className="wfe-field__label">Experts (standing pool)</div>
        {experts.map((ex, i) => (
          <ExpertRow
            key={i}
            expert={ex}
            index={i}
            workerDefs={workerDefs}
            modelOptions={modelOptions}
            onChange={(idx, next) => setExperts(experts.map((e, j) => (j === idx ? next : e)))}
            onRemove={(idx) => setExperts(experts.filter((_, j) => j !== idx))}
          />
        ))}
        <button type="button" className="wfe-mini-btn" onClick={() => setExperts([...experts, { id: "", prompt: "" }])}>+ expert</button>
      </div>

      <div className="wfe-insp__section">
        <JsonField
          label="Args schema"
          mode="schema"
          help="JSON-Schema for the run args (the input node's shape)"
          value={graph.argsSchema}
          onChange={(v) => onSetMeta({ argsSchema: v })}
        />
      </div>
    </div>
  );
}
