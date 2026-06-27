// The read-only run canvas: the editor's FlowCanvas in readOnly mode, fed the run's
// resolved v2 graph (rehydrated from the definition record) and live per-node
// coloring (nodeStates). No drag-connect, node-add, or config editing — pan / zoom /
// fit / minimap only. The graph layout is derived once per record; the SSE-driven
// nodeStates ride node `data.status` so a status tick never reshapes the graph.
import { useMemo } from "react";
import { FlowCanvas } from "../editor/FlowCanvas.jsx";
import { graphFromDoc } from "../editor/graphModel.js";
import { recordToDoc } from "../management/libraryModel.js";

export function RunCanvas({ record, nodeStates }) {
  const graph = useMemo(() => graphFromDoc(recordToDoc(record)), [record]);
  return <FlowCanvas graph={graph} nodeStates={nodeStates} readOnly active={false} />;
}
