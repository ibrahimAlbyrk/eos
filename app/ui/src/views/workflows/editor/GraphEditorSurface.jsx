// The reusable editing surface: palette (left) + the blur-free SVG canvas (center)
// + typed inspector (right), all driven by one useGraphEditor instance. Used by the
// top-level WorkflowEditor AND, recursively, by the nested loop-body sub-canvas —
// so the loop body is a REAL graph editor (same drag-to-connect, undo, typed
// inspector), not a JSON blob. `active` gates the canvas shortcuts so only the
// topmost surface reacts to the keyboard when an overlay is open.
import { lazy, Suspense, useCallback, useEffect } from "react";
import { Palette } from "./Palette.jsx";
import { Inspector } from "./Inspector.jsx";
import { isEnterableKind } from "./containerNav.js";

// The SVG renderer is the sole canvas — lazy so its chunk loads on demand.
const GraphRenderer = lazy(() => import("./GraphRenderer.jsx"));

// Stable default so the canvas sync effect (deps include nodeStates) doesn't
// re-fire mid-drag on a fresh inline `{}` from each re-render.
const EMPTY_NODE_STATES = {};

// `showPalette` keeps the in-surface palette for the nested loop-body overlay
// (LoopBodyEditor); the top-level editor sets it false and renders the palette in
// the left sidebar instead, leaving the canvas full-width here.
export function GraphEditorSurface({
  editor, catalog, loading, error, workerDefs, definitions,
  nodeStates = EMPTY_NODE_STATES, active = true, readOnly = false, graphMetaEnabled = false, onEditLoopBody,
  showPalette = true,
}) {
  // A create action selects the new node(s); the canvas mirrors the selection.
  useEffect(() => {
    if (editor.lastCreated) editor.setSelectedIds(editor.lastCreated);
  }, [editor.lastCreated]); // eslint-disable-line react-hooks/exhaustive-deps

  // Double-click a node ENTERS its nested content. Only `loop` carries an inline
  // body sub-graph, so it is the sole container that opens (subGraph references
  // another workflow by name, not an inline body). Read-only enters the same way —
  // the nested editor renders locked. Non-container double-clicks are a no-op.
  const onEnterNode = useCallback((nodeId) => {
    const node = editor.graph.nodes.find((n) => n.id === nodeId);
    if (node && isEnterableKind(node.kind)) onEditLoopBody?.(nodeId);
  }, [editor.graph, onEditLoopBody]);

  return (
    <div className="wfe-body">
      {showPalette && !readOnly && <Palette catalog={catalog} loading={loading} error={error} onAdd={editor.onAdd} />}
      <Suspense fallback={<div className="wf-rf-canvas wf-rf-canvas--loading">Loading canvas…</div>}>
        <GraphRenderer
          graph={editor.graph}
          catalog={catalog}
          nodeStates={nodeStates}
          active={active}
          readOnly={readOnly}
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
          onEnterNode={onEnterNode}
        />
      </Suspense>
      <Inspector
        key={editor.selectedNode?.id || "__meta__"}
        node={editor.selectedNode}
        graph={editor.graph}
        catalog={catalog}
        workerDefs={workerDefs}
        definitions={definitions}
        readOnly={readOnly}
        onUpdateNode={editor.onUpdateNode}
        onRemoveNode={editor.onRemoveNode}
        graphMeta={{ enabled: graphMetaEnabled, onSetMeta: editor.onSetMeta }}
      />
    </div>
  );
}
