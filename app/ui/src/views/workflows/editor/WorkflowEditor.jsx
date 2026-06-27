// The Workflows-tab node-graph editor. Composes the palette (left), the canvas
// (center), and the inspector (right) over one immutable graph state. Save → PUT
// /workflows (persist the v2 graph); Run → POST /workflows run-inline (operator-
// owned); live run progress highlights nodes off the SSE stream.
import { useMemo, useState } from "react";
import { api } from "../../../api/client.js";
import { Palette } from "./Palette.jsx";
import { Canvas } from "./Canvas.jsx";
import { Inspector } from "./Inspector.jsx";
import { useWorkflowCatalog } from "./useWorkflowCatalog.js";
import { useWorkflowRun } from "./useWorkflowRun.js";
import {
  createInitialGraph, addNode, removeNode, moveNode, updateNode,
  setGraphMeta, addEdge, removeEdge, toWorkflowGraph,
} from "./graphModel.js";

export function WorkflowEditor() {
  const { catalog, loading, error } = useWorkflowCatalog();
  const [graph, setGraph] = useState(() => createInitialGraph());
  const [selectedId, setSelectedId] = useState(null);
  const [pendingPort, setPendingPort] = useState(null);
  const [notice, setNotice] = useState(null); // { type: "err"|"ok"|"info", text }
  const [runId, setRunId] = useState(null);
  const [argsText, setArgsText] = useState("");

  const run = useWorkflowRun(runId);
  const selectedNode = useMemo(() => graph.nodes.find((n) => n.id === selectedId) || null, [graph, selectedId]);

  const flash = (type, text) => setNotice({ type, text });

  const onAdd = (entry) => {
    const pos = { x: 280 + (graph.counter % 6) * 26, y: 90 + (graph.counter % 9) * 30 };
    const res = addNode(graph, entry, pos);
    setGraph(res.state);
    setSelectedId(res.node.id);
  };

  const onPortClick = (nodeId, side, portName) => {
    if (side === "out") {
      setPendingPort({ node: nodeId, port: portName });
      flash("info", `connecting from ${nodeId}.${portName} — click a target input`);
      return;
    }
    // side === "in": complete a pending connection
    if (!pendingPort) return;
    const res = addEdge(graph, pendingPort, { node: nodeId, port: portName });
    if (res.error) {
      flash("err", `connection rejected: ${res.error}`);
    } else {
      setGraph(res.state);
      flash("ok", "connected");
    }
    setPendingPort(null);
  };

  const onSave = async () => {
    const payload = toWorkflowGraph(graph);
    if (!payload.name.trim()) { flash("err", "name the workflow before saving"); return; }
    const r = await api.saveWorkflow(payload);
    if (r.ok && r.body?.name) flash("ok", `saved "${r.body.name}"`);
    else flash("err", `save failed: ${r.body?.error || r.status}`);
  };

  const onRun = async () => {
    let args;
    if (argsText.trim()) {
      try { args = JSON.parse(argsText); } catch (e) { flash("err", `args must be JSON: ${e instanceof Error ? e.message : e}`); return; }
    }
    const r = await api.runWorkflow(toWorkflowGraph(graph), args);
    if (r.ok && r.body?.runId) { setRunId(r.body.runId); flash("ok", `run ${r.body.runId} started`); }
    else flash("err", `run failed: ${r.body?.error || r.status}`);
  };

  return (
    <div className="wfe">
      <div className="wfe-toolbar">
        <input
          className="wfe-name"
          type="text"
          value={graph.name}
          aria-label="workflow name"
          onChange={(e) => setGraph(setGraphMeta(graph, { name: e.target.value }))}
        />
        <input
          className="wfe-args"
          type="text"
          value={argsText}
          placeholder='args JSON (optional)'
          aria-label="run args"
          onChange={(e) => setArgsText(e.target.value)}
        />
        <button type="button" className="wfe-btn" onClick={onSave}>Save</button>
        <button type="button" className="wfe-btn wfe-btn--primary" onClick={onRun}>Run</button>
        {runId && (
          <span className="wfe-runchip">
            <span className="wfe-runchip__id">{runId}</span>
            <span className={"wf-status wf-status-" + (run.runStatus || "pending")}>{run.runStatus || "pending"}</span>
          </span>
        )}
        {notice && <span className={"wfe-notice wfe-notice--" + notice.type}>{notice.text}</span>}
      </div>
      <div className="wfe-body">
        <Palette catalog={catalog} loading={loading} error={error} onAdd={onAdd} />
        <Canvas
          graph={graph}
          selectedId={selectedId}
          nodeStates={run.nodeStates}
          pendingPort={pendingPort}
          onSelect={setSelectedId}
          onMoveNode={(id, x, y) => setGraph(moveNode(graph, id, x, y))}
          onPortClick={onPortClick}
          onRemoveEdge={(edgeId) => setGraph(removeEdge(graph, edgeId))}
          onBackgroundClick={() => { setSelectedId(null); setPendingPort(null); }}
        />
        <Inspector
          node={selectedNode}
          onUpdateNode={(id, patch) => setGraph(updateNode(graph, id, patch))}
          onRemoveNode={(id) => { setGraph(removeNode(graph, id)); setSelectedId(null); }}
        />
      </div>
    </div>
  );
}
