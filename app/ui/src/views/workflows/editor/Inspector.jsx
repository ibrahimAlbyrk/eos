// Right rail — the typed, per-kind node inspector. A GENERIC renderer driven by
// nodeConfigSchemas: for the selected node's kind it walks the schema's fields and
// renders the control each one declares. THE RULE (operator): every enum field is
// a selector (model/effort/transform-fn/from/subGraph dropdowns, predicate-op
// chips, port-type selects) — only prompts and binding refs are free text. All
// config edits flow back through graphModel (setConfigField → updateNode) so
// toWorkflowGraph still emits a valid v2 graph.
//
// When nothing is selected it shows the graph-level GraphMetaPanel (root editor
// only) so experts[] + argsSchema + name/description are always reachable.
import { useMemo } from "react";
import { PORT_TYPES, fieldsForKind, schemaForKind, setConfigField, bindingSuggestions } from "./nodeConfigSchemas.js";
import { Field, Select, Segmented, TextInput, TextArea, NumberInput, Tags, BindingRef } from "./inspectorControls.jsx";
import { PredicateField } from "./PredicateBuilder.jsx";
import { SpawnLoopForm } from "./SpawnLoopForm.jsx";
import { JsonField } from "./JsonField.jsx";
import { GraphMetaPanel } from "./GraphMetaPanel.jsx";
import { KindIcon } from "./KindIcon.jsx";
import { kindAccentVar } from "./nodeVisuals.js";
import { MODELS, EFFORTS, effortChoicesFor } from "../../../lib/models.js";
import { EFFORT_LEVELS } from "./nodeConfigSchemas.js";

// Resolve a field's option SOURCE to concrete dropdown/segmented options. The
// closed-set values come from live catalogs (models, transform fns, worker/workflow
// defs) or the gated effort set — never hand-typed.
function useFieldOptions({ catalog, workerDefs, definitions }, node) {
  return useMemo(() => {
    const modelOptions = MODELS.map((m) => ({ value: m.id, label: m.label, tag: m.tag }));
    return {
      models: modelOptions,
      transformFns: catalog?.transformFns || [],
      workerDefs: (workerDefs || []).map((d) => ({ value: d.name, label: d.name, tag: d.source })),
      definitions: (definitions || []).map((d) => ({ value: d.name, label: d.name, tag: d.source })),
      // effort is gated on the selected model AND clamped to the spawn-time enum
      // (effortChoicesFor may add the TUI-only `ultracode`, which the contract rejects).
      efforts: (effortChoicesFor(node?.config?.model) || EFFORTS)
        .filter((e) => EFFORT_LEVELS.includes(e.id))
        .map((e) => ({ value: e.id, label: e.label })),
    };
  }, [catalog, workerDefs, definitions, node?.config?.model]);
}

function retypePort(ports, name, type) {
  return ports.map((p) => (p.name === name ? { ...p, type } : p));
}

function PortRow({ port, onChange }) {
  return (
    <div className="wfe-insp__port">
      <span className="wfe-insp__port-name">{port.name}</span>
      <Select value={port.type} options={PORT_TYPES} onChange={(t) => onChange(port.name, t || "any")} allowEmpty={false} />
    </div>
  );
}

// Render one config field by its control type.
function ConfigField({ field, node, value, suggestions, options, onChange, onEditLoopBody }) {
  const common = { label: field.label, required: field.required, help: field.help };
  switch (field.control) {
    case "textarea":
      return <Field {...common}><TextArea value={value} onChange={onChange} placeholder={field.placeholder} /></Field>;
    case "text":
      return <Field {...common}><TextInput value={value} onChange={onChange} placeholder={field.placeholder} /></Field>;
    case "number":
      return <Field {...common}><NumberInput value={value} min={field.min} onChange={onChange} /></Field>;
    case "tags":
      return <Field {...common}><Tags value={value} onChange={onChange} placeholder={field.placeholder} /></Field>;
    case "binding-ref":
      return (
        <Field {...common}>
          <BindingRef value={value} onChange={onChange} suggestions={suggestions} placeholder={field.placeholder} listId={`bind-${node.id}-${field.key}`} />
        </Field>
      );
    case "select":
      return (
        <Field {...common}>
          <Select
            value={value}
            options={options[field.optionsKey] || []}
            onChange={onChange}
            allowEmpty={!field.required}
            placeholder={field.placeholder || "— none —"}
          />
        </Field>
      );
    case "segmented":
      return (
        <Field {...common}>
          <Segmented value={value} options={options[field.optionsKey] || []} onChange={onChange} clearable={!field.required} />
        </Field>
      );
    case "predicate":
      return <PredicateField label={field.label} required={field.required} value={value} onChange={onChange} suggestions={suggestions} path={`pred-${node.id}-${field.key}`} />;
    case "json-schema":
      return <JsonField label={field.label} required={field.required} value={value} mode="schema" help={field.help} onChange={onChange} />;
    case "json-literal":
      return <JsonField label={field.label} required={field.required} value={value} mode="literal" help={field.help} onChange={onChange} />;
    case "spawn-loop":
      return <SpawnLoopForm value={value} onChange={onChange} />;
    case "sub-canvas":
      return <LoopBodyField field={field} node={node} value={value} onEditLoopBody={onEditLoopBody} />;
    default:
      return null;
  }
}

// The loop body is a nested graph, not an inline value — open the nested canvas.
function LoopBodyField({ field, node, value, onEditLoopBody }) {
  const nodeCount = Array.isArray(value?.nodes) ? value.nodes.length : 0;
  return (
    <Field label={field.label} required={field.required} help={field.help}>
      <button type="button" className="wfe-mini-btn wfe-mini-btn--wide" onClick={() => onEditLoopBody(node.id)}>
        {nodeCount > 0 ? `Edit loop body (${nodeCount} nodes)` : "Edit loop body…"}
      </button>
    </Field>
  );
}

export function Inspector({ node, graph, catalog, workerDefs, definitions, onUpdateNode, onRemoveNode, onEditLoopBody, graphMeta }) {
  const options = useFieldOptions({ catalog, workerDefs, definitions }, node);
  const suggestions = useMemo(() => bindingSuggestions(graph, node?.id), [graph, node?.id]);

  if (!node) {
    if (graphMeta?.enabled) {
      return (
        <div className="wfe-inspector">
          <GraphMetaPanel graph={graph} onSetMeta={graphMeta.onSetMeta} workerDefs={workerDefs} modelOptions={options.models} />
        </div>
      );
    }
    return (
      <div className="wfe-inspector wfe-inspector--empty">
        <div className="wfe-inspector__hint">Select a node to configure it.</div>
      </div>
    );
  }

  const schema = schemaForKind(node.kind);
  const fields = fieldsForKind(node.kind);
  const setCfg = (key, v) => onUpdateNode(node.id, { config: setConfigField(node.config, key, v) });

  return (
    <div className="wfe-inspector">
      <div className="wfe-inspector__header">
        <span className="wfe-insp-kicon" style={{ color: `var(${kindAccentVar(node.kind)})` }}>
          <KindIcon kind={node.kind} size={15} className="" />
        </span>
        <span className="wfe-inspector__title">{node.kind}</span>
        <span className="wfe-inspector__id">{node.id}</span>
      </div>

      <Field label="Label"><TextInput value={node.label || ""} onChange={(v) => onUpdateNode(node.id, { label: v })} /></Field>

      {schema.trustGate && (
        <div className="wfe-banner wfe-banner--warn">
          Trusted script node — this graph can be saved and run by name, but not run inline.
        </div>
      )}
      {schema.note && <div className="wfe-banner">{schema.note}</div>}

      {(node.inputs?.length > 0 || node.outputs?.length > 0) && (
        <div className="wfe-insp__section">
          <div className="wfe-field__label">Ports</div>
          {node.inputs?.map((p) => (
            <PortRow key={"in-" + p.name} port={p} onChange={(name, type) => onUpdateNode(node.id, { inputs: retypePort(node.inputs, name, type) })} />
          ))}
          {node.outputs?.map((p) => (
            <PortRow key={"out-" + p.name} port={p} onChange={(name, type) => onUpdateNode(node.id, { outputs: retypePort(node.outputs, name, type) })} />
          ))}
        </div>
      )}

      {fields.length > 0 && (
        <div className="wfe-insp__section">
          <div className="wfe-field__label">Config</div>
          {fields.map((field) => (
            <ConfigField
              key={field.key}
              field={field}
              node={node}
              value={node.config?.[field.key]}
              suggestions={suggestions}
              options={options}
              onChange={(v) => setCfg(field.key, v)}
              onEditLoopBody={onEditLoopBody}
            />
          ))}
        </div>
      )}

      <button type="button" className="wfe-btn wfe-btn--danger" onClick={() => onRemoveNode(node.id)}>
        Delete node
      </button>
    </div>
  );
}
