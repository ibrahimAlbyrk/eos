// Right rail — edit the selected node: its label, its port types (so the author
// can retype a port and see edge-compatibility change), and its kind-specific
// `config` as JSON. Empty when nothing is selected.
import { useEffect, useState } from "react";
import { PORT_TYPES } from "./portTypes.js";

function retypePort(ports, name, type) {
  return ports.map((p) => (p.name === name ? { ...p, type } : p));
}

function PortTypeRow({ port, onChange }) {
  return (
    <label className="wfe-insp__port">
      <span className="wfe-insp__port-name">{port.name}</span>
      <select value={port.type} onChange={(e) => onChange(port.name, e.target.value)}>
        {PORT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
    </label>
  );
}

export function Inspector({ node, onUpdateNode, onRemoveNode }) {
  const [configText, setConfigText] = useState("");
  const [configErr, setConfigErr] = useState(null);

  useEffect(() => {
    setConfigErr(null);
    if (!node) { setConfigText(""); return; }
    setConfigText(node.config === undefined ? "" : JSON.stringify(node.config, null, 2));
  }, [node?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!node) {
    return (
      <div className="wfe-inspector wfe-inspector--empty">
        <div className="wfe-inspector__hint">Select a node to edit it.</div>
      </div>
    );
  }

  const commitConfig = (text) => {
    setConfigText(text);
    const trimmed = text.trim();
    if (!trimmed) { setConfigErr(null); onUpdateNode(node.id, { config: undefined }); return; }
    try {
      const parsed = JSON.parse(trimmed);
      setConfigErr(null);
      onUpdateNode(node.id, { config: parsed });
    } catch (e) {
      setConfigErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="wfe-inspector">
      <div className="wfe-inspector__title">{node.kind}</div>

      <label className="wfe-field">
        <span className="wfe-field__label">Label</span>
        <input
          type="text"
          value={node.label || ""}
          onChange={(e) => onUpdateNode(node.id, { label: e.target.value })}
        />
      </label>

      <label className="wfe-field">
        <span className="wfe-field__label">Node id</span>
        <input type="text" value={node.id} readOnly className="wfe-field__ro" />
      </label>

      {node.inputs?.length > 0 && (
        <div className="wfe-insp__ports">
          <div className="wfe-field__label">Input ports</div>
          {node.inputs.map((p) => (
            <PortTypeRow key={p.name} port={p} onChange={(name, type) => onUpdateNode(node.id, { inputs: retypePort(node.inputs, name, type) })} />
          ))}
        </div>
      )}

      {node.outputs?.length > 0 && (
        <div className="wfe-insp__ports">
          <div className="wfe-field__label">Output ports</div>
          {node.outputs.map((p) => (
            <PortTypeRow key={p.name} port={p} onChange={(name, type) => onUpdateNode(node.id, { outputs: retypePort(node.outputs, name, type) })} />
          ))}
        </div>
      )}

      <label className="wfe-field">
        <span className="wfe-field__label">Config (JSON)</span>
        <textarea
          className="wfe-field__config"
          rows={6}
          value={configText}
          placeholder={'{ "prompt": "…" }'}
          onChange={(e) => commitConfig(e.target.value)}
        />
        {configErr && <span className="wfe-field__err">{configErr}</span>}
      </label>

      <button type="button" className="wfe-btn wfe-btn--danger" onClick={() => onRemoveNode(node.id)}>
        Delete node
      </button>
    </div>
  );
}
