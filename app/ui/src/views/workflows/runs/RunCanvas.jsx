// The read-only run canvas: the shared read-only host (SVG canvas + locked inspector)
// fed the run's resolved v2 graph (rehydrated from the definition record) and live
// per-node coloring (nodeStates). Pan / zoom / fit / minimap + click-to-select-and-
// inspect only — no drag-connect, node-add, or config editing. The graph layout is
// derived once per record; the SSE-driven nodeStates ride node `data.status` so a
// status tick never reshapes the graph.
import { useMemo } from "react";
import { graphFromDoc } from "../editor/graphModel.js";
import { recordToDoc } from "../management/libraryModel.js";
import { ReadOnlyGraphCanvas } from "../editor/ReadOnlyGraphCanvas.jsx";

export function RunCanvas({ record, nodeStates }) {
  const graph = useMemo(() => graphFromDoc(recordToDoc(record)), [record]);
  return <ReadOnlyGraphCanvas graph={graph} nodeStates={nodeStates} />;
}
