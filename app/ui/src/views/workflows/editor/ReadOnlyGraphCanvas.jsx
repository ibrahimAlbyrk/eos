// Read-only canvas host: the blur-free SVG renderer + a LOCKED inspector, sharing one
// selection. Used by the Runs view (RunCanvas) and the Library read-only detail. In
// the renderer's readOnly mode a click SELECTS a node (or edge) but no edit gesture
// arms; the inspector then shows the picked node's config locked (no field edits, no
// delete). Catalogs feed the inspector's selectors so values render with their labels.
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { Inspector } from "./Inspector.jsx";
import { LoopBodyEditor } from "./LoopBodyEditor.jsx";
import { isEnterableKind } from "./containerNav.js";
import { useWorkflowCatalog } from "./useWorkflowCatalog.js";
import { useWorkerDefinitions, useWorkflowDefinitions } from "./useEditorCatalogs.js";

// The SVG renderer is the sole canvas — lazy so its chunk loads on demand.
const GraphRenderer = lazy(() => import("./GraphRenderer.jsx"));

const NOOP = () => {};
const EMPTY_NODE_STATES = {};

export function ReadOnlyGraphCanvas({ graph, nodeStates = EMPTY_NODE_STATES }) {
  const { catalog } = useWorkflowCatalog();
  const workerDefs = useWorkerDefinitions();
  const definitions = useWorkflowDefinitions();

  const [selectedIds, setSelectedIds] = useState([]);
  // The loop whose body is being VIEWED read-only (double-click to enter). The
  // nested LoopBodyEditor overlay carries its own selection + recursion, so this
  // host only tracks the entry point and the way back out.
  const [enteredLoopId, setEnteredLoopId] = useState(null);
  const selectedNode = useMemo(
    () => (selectedIds.length ? graph.nodes.find((n) => n.id === selectedIds[0]) || null : null),
    [graph, selectedIds],
  );

  // Only `loop` carries an inline body sub-graph to enter; subGraph references
  // another workflow by name (no inline content), so it does not open here.
  const onEnterNode = useCallback((nodeId) => {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (node && isEnterableKind(node.kind)) setEnteredLoopId(nodeId);
  }, [graph]);

  const enteredNode = enteredLoopId ? graph.nodes.find((n) => n.id === enteredLoopId) : null;

  return (
    <div className="wfe-ro-host">
      <div className="wfe-body">
        <Suspense fallback={<div className="wf-rf-canvas wf-rf-canvas--loading">Loading canvas…</div>}>
          <GraphRenderer
            graph={graph}
            catalog={catalog}
            nodeStates={nodeStates}
            active={false}
            readOnly
            onSelect={setSelectedIds}
            onEnterNode={onEnterNode}
          />
        </Suspense>
        <Inspector
          key={selectedNode?.id || "__empty__"}
          node={selectedNode}
          graph={graph}
          catalog={catalog}
          workerDefs={workerDefs}
          definitions={definitions}
          readOnly
          onUpdateNode={NOOP}
          onRemoveNode={NOOP}
        />
      </div>
      {enteredNode && (
        <LoopBodyEditor
          value={enteredNode.config?.body}
          title={`Loop body — ${enteredNode.label || enteredNode.id}`}
          catalog={catalog}
          workerDefs={workerDefs}
          definitions={definitions}
          readOnly
          onCommit={NOOP}
          onClose={() => setEnteredLoopId(null)}
        />
      )}
    </div>
  );
}
