// The Workflows-tab node-graph editor. Composes the reusable GraphEditorSurface
// (palette + React Flow canvas + typed inspector) over one useGraphEditor instance
// — the single controlled source of truth — plus the toolbar (name/undo/save) and
// the nested loop-body overlay. The editor only SAVES (Save → PUT /workflows,
// persisting the v2 graph). Workflows are LAUNCHED only by agents / the CLI; run
// observation lives entirely in the Runs view (no inline run in the editor).
//
// Phase 3: the inspector is typed per node kind (selectors for every enum), the
// right rail shows the graph-level GraphMetaPanel when nothing is selected, and a
// loop node opens its body on a real nested canvas (LoopBodyEditor).
import { useEffect, useMemo, useState } from "react";
import { api } from "../../../api/client.js";
import { useWorkflowCatalog } from "./useWorkflowCatalog.js";
import { useWorkerDefinitions, useWorkflowDefinitions } from "./useEditorCatalogs.js";
import { useGraphEditor } from "./useGraphEditor.js";
import { GraphEditorSurface } from "./GraphEditorSurface.jsx";
import { LoopBodyEditor } from "./LoopBodyEditor.jsx";
import { createInitialGraph, toWorkflowGraph, graphFromDoc } from "./graphModel.js";
import { setConfigField } from "./nodeConfigSchemas.js";

// `loadReq` ({ doc, nonce }) is the Library → Editor handoff: when its nonce
// changes the editor replaces its graph with that definition's doc (graphFromDoc
// rehydrates the same pure model the canvas drives). nonce, not doc identity,
// gates it so re-opening the same definition still loads.
export function WorkflowEditor({ loadReq = null }) {
  const { catalog, loading, error } = useWorkflowCatalog();
  const workerDefs = useWorkerDefinitions();
  const definitions = useWorkflowDefinitions();
  const editor = useGraphEditor(() => createInitialGraph());
  const { graph } = editor;

  const [notice, setNotice] = useState(null); // { type: "err"|"ok"|"info", text }
  const [editingLoopId, setEditingLoopId] = useState(null);

  const editingNode = useMemo(
    () => (editingLoopId ? graph.nodes.find((n) => n.id === editingLoopId) || null : null),
    [editingLoopId, graph],
  );

  const flash = (type, text) => setNotice({ type, text });

  useEffect(() => {
    if (loadReq?.doc) {
      editor.replaceGraph(graphFromDoc(loadReq.doc));
      flash("info", `loaded "${loadReq.doc.name || "workflow"}"`);
    }
  }, [loadReq?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSave = async () => {
    const payload = toWorkflowGraph(graph);
    if (!payload.name.trim()) { flash("err", "name the workflow before saving"); return; }
    const r = await api.saveWorkflow(payload);
    if (r.ok && r.body?.name) flash("ok", `saved "${r.body.name}"`);
    else flash("err", `save failed: ${r.body?.error || r.status}`);
  };

  return (
    <div className="wfe">
      <div className="wfe-toolbar">
        <input
          className="wfe-name"
          type="text"
          value={graph.name}
          aria-label="workflow name"
          onChange={(e) => editor.onSetMeta({ name: e.target.value })}
        />
        <button type="button" className="wfe-btn" onClick={editor.onUndo} disabled={!editor.canUndo} title="Undo (⌘Z)">Undo</button>
        <button type="button" className="wfe-btn" onClick={editor.onRedo} disabled={!editor.canRedo} title="Redo (⇧⌘Z)">Redo</button>
        <button type="button" className="wfe-btn wfe-btn--primary" onClick={onSave}>Save</button>
        {notice && <span className={"wfe-notice wfe-notice--" + notice.type}>{notice.text}</span>}
      </div>

      <GraphEditorSurface
        editor={editor}
        catalog={catalog}
        loading={loading}
        error={error}
        workerDefs={workerDefs}
        definitions={definitions}
        active={!editingLoopId}
        graphMetaEnabled
        onEditLoopBody={setEditingLoopId}
      />

      {editingNode && (
        <LoopBodyEditor
          value={editingNode.config?.body}
          title={`Loop body — ${editingNode.label || editingNode.id}`}
          catalog={catalog}
          loading={loading}
          error={error}
          workerDefs={workerDefs}
          definitions={definitions}
          onCommit={(bodyDoc) => editor.onUpdateNode(editingNode.id, { config: setConfigField(editingNode.config, "body", bodyDoc) })}
          onClose={() => setEditingLoopId(null)}
        />
      )}
    </div>
  );
}
