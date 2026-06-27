// The reusable editing surface: palette (left) + React Flow canvas (center) +
// typed inspector (right), all driven by one useGraphEditor instance. Used by the
// top-level WorkflowEditor AND, recursively, by the nested loop-body sub-canvas —
// so the loop body is a REAL graph editor (same drag-to-connect, undo, typed
// inspector), not a JSON blob. `active` gates the canvas shortcuts so only the
// topmost surface reacts to the keyboard when an overlay is open.
import { lazy, Suspense, useEffect } from "react";
import { Palette } from "./Palette.jsx";
import { Inspector } from "./Inspector.jsx";

const FlowCanvas = lazy(() => import("./FlowCanvas.jsx"));

export function GraphEditorSurface({
  editor, catalog, loading, error, workerDefs, definitions,
  nodeStates = {}, active = true, graphMetaEnabled = false, onEditLoopBody,
}) {
  // A create action selects the new node(s); the canvas mirrors it into RF.
  useEffect(() => {
    if (editor.lastCreated) editor.setSelectedIds(editor.lastCreated);
  }, [editor.lastCreated]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="wfe-body">
      <Palette catalog={catalog} loading={loading} error={error} onAdd={editor.onAdd} />
      <Suspense fallback={<div className="wf-rf-canvas wf-rf-canvas--loading">Loading canvas…</div>}>
        <FlowCanvas
          graph={editor.graph}
          catalog={catalog}
          nodeStates={nodeStates}
          active={active}
          pendingSelect={editor.lastCreated}
          registerAddAtCenter={editor.registerAddAtCenter}
          onSelect={editor.setSelectedIds}
          onConnectEdge={editor.onConnectEdge}
          onReroute={editor.onReroute}
          onMoveNodes={editor.onMoveNodes}
          onDeleteSelection={editor.onDeleteSelection}
          onRemoveEdge={editor.onRemoveEdge}
          onAddNodeAt={editor.onAddNodeAt}
          onSpawnFromPort={editor.onSpawnFromPort}
          onCopy={editor.onCopy}
          onPaste={editor.onPaste}
          onDuplicate={editor.onDuplicate}
          onUndo={editor.onUndo}
          onRedo={editor.onRedo}
        />
      </Suspense>
      <Inspector
        key={editor.selectedNode?.id || "__meta__"}
        node={editor.selectedNode}
        graph={editor.graph}
        catalog={catalog}
        workerDefs={workerDefs}
        definitions={definitions}
        onUpdateNode={editor.onUpdateNode}
        onRemoveNode={editor.onRemoveNode}
        onEditLoopBody={onEditLoopBody}
        graphMeta={{ enabled: graphMetaEnabled, onSetMeta: editor.onSetMeta }}
      />
    </div>
  );
}
