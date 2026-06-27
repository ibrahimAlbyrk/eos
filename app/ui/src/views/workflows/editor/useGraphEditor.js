// The controlled graph-editor state, extracted so BOTH the top-level editor and
// the nested loop-body sub-canvas drive the same pure graphModel ops + undo stack.
// A useReducer holds { graph, history, lastCreated } — the only thing that mutates
// the persisted doc — and every committed op routes through it and records an undo
// snapshot. React Flow owns ephemeral viewport/selection/in-flight-drag and reports
// interactions back as the semantic callbacks returned here.
import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import {
  initUndo, recordDiscrete, recordCoalescing, undo as undoStack, redo as redoStack, bound, canUndo, canRedo,
} from "../../../lib/undoStack.js";
import { firstCompatiblePort } from "./quickAdd.js";
import {
  addNode, addEdge, rerouteEdge, moveNode, updateNode, removeNodes, removeEdge,
  setGraphMeta, copyNodes, pasteNodes, duplicateNodes,
} from "./graphModel.js";

const PASTE_OFFSET = { x: 32, y: 32 };
const pushDiscrete = (history, graph) => bound(recordDiscrete(history, graph));
const pushCoalescing = (history, graph) => bound(recordCoalescing(history, graph));

// `lastCreated` carries ids a create action just made so the editor selects them
// (and tells RF to). Reset to null by every other action so a stale select-of-new
// isn't re-applied on undo/move/etc.
export function graphReducer(state, action) {
  const { graph, history } = state;
  switch (action.type) {
    case "replace":
      return { graph: action.graph, history: initUndo(action.graph), lastCreated: null };
    case "connect": {
      const res = addEdge(graph, action.from, action.to);
      if (res.error) return state;
      return { graph: res.state, history: pushDiscrete(history, res.state), lastCreated: null };
    }
    case "reroute": {
      const res = rerouteEdge(graph, action.edgeId, action.from, action.to);
      if (res.error) return state;
      return { graph: res.state, history: pushDiscrete(history, res.state), lastCreated: null };
    }
    case "move": {
      const next = action.moves.reduce((acc, m) => moveNode(acc, m.id, m.x, m.y), graph);
      return { graph: next, history: pushDiscrete(history, next), lastCreated: null };
    }
    case "delete": {
      let next = removeNodes(graph, action.nodeIds);
      for (const id of action.edgeIds || []) next = removeEdge(next, id);
      if (next === graph) return state;
      return { graph: next, history: pushDiscrete(history, next), lastCreated: null };
    }
    case "addNode": {
      const res = addNode(graph, action.entry, action.pos);
      return { graph: res.state, history: pushDiscrete(history, res.state), lastCreated: [res.node.id] };
    }
    case "spawnFromPort": {
      const res = addNode(graph, action.entry, action.pos);
      let g = res.state;
      const port = firstCompatiblePort(action.entry, action.draggedType, action.dragHandle.side);
      if (port) {
        const e = action.dragHandle.side === "out"
          ? addEdge(g, { node: action.dragHandle.nodeId, port: action.dragHandle.port }, { node: res.node.id, port })
          : addEdge(g, { node: res.node.id, port }, { node: action.dragHandle.nodeId, port: action.dragHandle.port });
        if (!e.error) g = e.state;
      }
      return { graph: g, history: pushDiscrete(history, g), lastCreated: [res.node.id] };
    }
    case "paste": {
      const res = pasteNodes(graph, action.clipboard, action.offset || PASTE_OFFSET);
      if (res.nodeIds.length === 0) return state;
      return { graph: res.state, history: pushDiscrete(history, res.state), lastCreated: res.nodeIds };
    }
    case "duplicate": {
      const res = duplicateNodes(graph, action.ids, PASTE_OFFSET);
      if (res.nodeIds.length === 0) return state;
      return { graph: res.state, history: pushDiscrete(history, res.state), lastCreated: res.nodeIds };
    }
    case "updateNode": {
      const next = updateNode(graph, action.id, action.patch);
      return { graph: next, history: pushCoalescing(history, next), lastCreated: null };
    }
    case "setMeta": {
      const next = setGraphMeta(graph, action.patch);
      return { graph: next, history: pushCoalescing(history, next), lastCreated: null };
    }
    case "undo": {
      const r = undoStack(history);
      return r.snapshot ? { graph: r.snapshot, history: r.state, lastCreated: null } : { ...state, history: r.state };
    }
    case "redo": {
      const r = redoStack(history);
      return r.snapshot ? { graph: r.snapshot, history: r.state, lastCreated: null } : { ...state, history: r.state };
    }
    default:
      return state;
  }
}

export function useGraphEditor(makeInitialGraph) {
  const [state, dispatch] = useReducer(graphReducer, undefined, () => {
    const g = makeInitialGraph();
    return { graph: g, history: initUndo(g), lastCreated: null };
  });
  const { graph, history, lastCreated } = state;
  const [selectedIds, setSelectedIds] = useState([]);
  const [clipboard, setClipboard] = useState(null);
  const addAtCenterRef = useRef(null);

  const selectedNode = useMemo(
    () => (selectedIds.length === 1 ? graph.nodes.find((n) => n.id === selectedIds[0]) || null : null),
    [graph, selectedIds],
  );

  const onAdd = useCallback((entry) => {
    if (addAtCenterRef.current) addAtCenterRef.current(entry);
    else dispatch({ type: "addNode", entry, pos: { x: 360, y: 200 } });
  }, []);
  const onAddNodeAt = useCallback((entry, pos) => dispatch({ type: "addNode", entry, pos }), []);
  const onSpawnFromPort = useCallback(
    (entry, pos, dragHandle, draggedType) => dispatch({ type: "spawnFromPort", entry, pos, dragHandle, draggedType }), []);
  const onConnectEdge = useCallback((from, to) => dispatch({ type: "connect", from, to }), []);
  const onReroute = useCallback((edgeId, from, to) => dispatch({ type: "reroute", edgeId, from, to }), []);
  const onMoveNodes = useCallback((moves) => dispatch({ type: "move", moves }), []);
  const onRemoveEdge = useCallback((id) => dispatch({ type: "delete", nodeIds: [], edgeIds: [id] }), []);
  const onDeleteSelection = useCallback((nodeIds, edgeIds) => dispatch({ type: "delete", nodeIds, edgeIds }), []);
  const onCopy = useCallback((ids) => setClipboard(copyNodes(graph, ids)), [graph]);
  const onPaste = useCallback((flowPos) => {
    if (!clipboard || clipboard.nodes.length === 0) return;
    let offset = PASTE_OFFSET;
    if (flowPos) {
      const anchor = clipboard.nodes[0].ui;
      offset = { x: flowPos.x - anchor.x, y: flowPos.y - anchor.y };
    }
    dispatch({ type: "paste", clipboard, offset });
  }, [clipboard]);
  const onDuplicate = useCallback((ids) => dispatch({ type: "duplicate", ids }), []);
  const onUndo = useCallback(() => dispatch({ type: "undo" }), []);
  const onRedo = useCallback(() => dispatch({ type: "redo" }), []);
  const onUpdateNode = useCallback((id, patch) => dispatch({ type: "updateNode", id, patch }), []);
  const onRemoveNode = useCallback((id) => dispatch({ type: "delete", nodeIds: [id], edgeIds: [] }), []);
  const onSetMeta = useCallback((patch) => dispatch({ type: "setMeta", patch }), []);
  const replaceGraph = useCallback((g) => dispatch({ type: "replace", graph: g }), []);
  const registerAddAtCenter = useCallback((fn) => { addAtCenterRef.current = fn; }, []);

  return {
    graph, history, lastCreated, selectedIds, setSelectedIds, selectedNode, clipboard,
    canUndo: canUndo(history), canRedo: canRedo(history),
    onAdd, onAddNodeAt, onSpawnFromPort, onConnectEdge, onReroute, onMoveNodes, onRemoveEdge,
    onDeleteSelection, onCopy, onPaste, onDuplicate, onUndo, onRedo, onUpdateNode, onRemoveNode,
    onSetMeta, replaceGraph, registerAddAtCenter,
  };
}
