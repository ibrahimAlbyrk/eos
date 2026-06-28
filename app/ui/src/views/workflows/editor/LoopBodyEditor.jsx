// The FULL nested loop-body editor (operator: NOT staged, NOT a JSON textarea).
// A loop node's body is itself a graph; this opens it on a real nested React Flow
// canvas — the SAME GraphEditorSurface (palette + canvas + typed inspector) the
// top-level editor uses, over its OWN useGraphEditor instance hydrated from the
// stored body. It is RECURSIVE: a loop inside the body opens another LoopBodyEditor.
// Body edits commit live back into the parent loop node's config.body, so
// toWorkflowGraph emits the encapsulated body and the top graph stays acyclic.
import { useEffect, useState } from "react";
import { GraphEditorSurface } from "./GraphEditorSurface.jsx";
import { useGraphEditor } from "./useGraphEditor.js";
import { createInitialGraph, graphFromDoc, toWorkflowGraph } from "./graphModel.js";
import { setConfigField } from "./nodeConfigSchemas.js";

export function LoopBodyEditor({ value, title, catalog, loading, error, workerDefs, definitions, readOnly = false, onCommit, onClose, depth = 0 }) {
  const editor = useGraphEditor(() =>
    value && Array.isArray(value.nodes) && value.nodes.length
      ? graphFromDoc(value)
      : createInitialGraph({ name: "loop-body", byKind: catalog?.byKind || {} }),
  );

  // A nested loop inside THIS body opens a deeper editor; this surface goes
  // inactive so only the topmost canvas reacts to the keyboard.
  const [editingLoopId, setEditingLoopId] = useState(null);

  // Commit the body live to the parent loop node (init body included), keeping
  // graphModel the single source of truth for the persisted doc. A read-only view
  // never writes back (it only renders the stored body).
  useEffect(() => {
    if (!readOnly) onCommit(toWorkflowGraph(editor.graph));
  }, [editor.graph]); // eslint-disable-line react-hooks/exhaustive-deps

  const editingNode = editingLoopId ? editor.graph.nodes.find((n) => n.id === editingLoopId) : null;

  return (
    <div className="wfe-loop-overlay" style={{ zIndex: 50 + depth }}>
      <div className="wfe-loop-overlay__bar">
        <span className="wfe-loop-overlay__title">{title}</span>
        <button type="button" className="wfe-btn wfe-btn--primary" onClick={onClose}>{readOnly ? "Back" : "Done"}</button>
      </div>
      <GraphEditorSurface
        editor={editor}
        catalog={catalog}
        loading={loading}
        error={error}
        workerDefs={workerDefs}
        definitions={definitions}
        readOnly={readOnly}
        active={!editingLoopId}
        graphMetaEnabled={false}
        onEditLoopBody={setEditingLoopId}
      />
      {editingNode && (
        <LoopBodyEditor
          value={editingNode.config?.body}
          title={`${title} › ${editingNode.label || editingNode.id}`}
          catalog={catalog}
          loading={loading}
          error={error}
          workerDefs={workerDefs}
          definitions={definitions}
          readOnly={readOnly}
          depth={depth + 1}
          onCommit={(bodyDoc) => editor.onUpdateNode(editingNode.id, { config: setConfigField(editingNode.config, "body", bodyDoc) })}
          onClose={() => setEditingLoopId(null)}
        />
      )}
    </div>
  );
}
