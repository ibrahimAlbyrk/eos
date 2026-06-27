// The React Flow canvas — the rendering substrate that replaces the custom
// Canvas. THE CONTROLLED BOUNDARY: graphModel (passed in as `graph`) is the single
// source of truth for the persisted document; React Flow owns ONLY ephemeral
// interaction state (viewport, selection, and node position WHILE a drag is in
// flight). We sync graph → RF on structural change and report interactions back as
// semantic callbacks; the parent commits them into graphModel via the pure ops and
// records an undo snapshot.
//
//   onConnect        → onConnectEdge   (gated first by isValidConnection→canConnect)
//   onReconnect      → onReroute       (grab a connected handle, re-drop elsewhere)
//   onConnectEnd     → spawn menu      (release on empty canvas → compatible kinds)
//   onNodeDragStop   → onMoveNodes     (positions committed ONCE, on drag stop)
//   onDelete         → onDeleteSelection (RF only offers deletable nodes/edges)
//   onSelectionChange→ onSelect        (selection set drives inspector + copy ops)
//
// Fast node-add: double-click / Tab → quick-add at cursor; palette HTML5-drop at
// the drop point; drag-from-port → empty → compatible spawn menu (auto-wires).
// Keyboard: Cmd/Ctrl+Z / Shift+Z undo-redo, +C/+V/+D copy-paste-duplicate, +A
// select-all. Delete/Backspace removes the selection (input/output non-deletable).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Panel,
  SelectionMode, useNodesState, useEdgesState, useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { WfNode } from "./WfNode.jsx";
import { WfEdge } from "./WfEdge.jsx";
import { WfConnectionContext } from "./wfConnection.js";
import { QuickAddMenu } from "./QuickAddMenu.jsx";
import { PALETTE_DND_MIME } from "./Palette.jsx";
import { addableKinds, compatibleKinds } from "./quickAdd.js";
import {
  toRfNodes, toRfEdges, fromRfConnection, connectionIsValid, handleReceptivity,
} from "./rfAdapter.js";

// Defined ONCE at module scope: React Flow remounts every node/edge if these
// object identities change between renders (a classic footgun).
const NODE_TYPES = { wfNode: WfNode };
const EDGE_TYPES = { wfEdge: WfEdge };
const GRID = 22;

// The pointer coords of a connect-end / drag event, normalized across mouse+touch.
function pointerOf(event) {
  if (event && typeof event.clientX === "number") return { x: event.clientX, y: event.clientY };
  const t = event?.changedTouches?.[0] || event?.touches?.[0];
  return t ? { x: t.clientX, y: t.clientY } : { x: 0, y: 0 };
}

const NOOP = () => {};

function FlowCanvasInner({
  graph, catalog = { kinds: [], byKind: {} }, nodeStates, pendingSelect, registerAddAtCenter,
  onSelect = NOOP, onConnectEdge = NOOP, onReroute = NOOP, onMoveNodes = NOOP,
  onDeleteSelection = NOOP, onRemoveEdge = NOOP, onAddNodeAt = NOOP, onSpawnFromPort = NOOP,
  onCopy = NOOP, onPaste = NOOP, onDuplicate = NOOP, onUndo = NOOP, onRedo = NOOP,
  active = true, readOnly = false,
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [connSource, setConnSource] = useState(null);
  const [menu, setMenu] = useState(null); // { clientX, clientY, kinds, pick, title }
  const [snap, setSnap] = useState(false);

  const { screenToFlowPosition } = useReactFlow();
  const wrapperRef = useRef(null);
  const lastClientRef = useRef(null);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const reconnectDone = useRef(true);

  // Sync graphModel → RF on structural change. Merge over the previous RF nodes so
  // RF-owned ephemeral fields (selection, measured size, dragging) survive a
  // rebuild; toRfNode deliberately omits `selected`, so `...next` never clobbers
  // RF's live selection. Never runs mid-drag (dragging doesn't touch `graph`).
  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return toRfNodes(graph, { nodeStates }).map((next) => {
        const old = prevById.get(next.id);
        return old ? { ...old, ...next, data: next.data } : next;
      });
    });
  }, [graph, nodeStates, setNodes]);

  useEffect(() => {
    setEdges((prev) => {
      const prevById = new Map(prev.map((e) => [e.id, e]));
      return toRfEdges(graph, { nodeStates }).map((next) => {
        const old = prevById.get(next.id);
        return old ? { ...old, ...next } : next;
      });
    });
  }, [graph, nodeStates, setEdges]);

  // Programmatic selection: after add / spawn / paste / duplicate the parent hands
  // down the freshly-created ids; mark exactly those selected in RF (which then
  // reports back via onSelectionChange, keeping the inspector in sync).
  useEffect(() => {
    if (!pendingSelect || pendingSelect.length === 0) return;
    const want = new Set(pendingSelect);
    setNodes((ns) => ns.map((n) => ({ ...n, selected: want.has(n.id) })));
  }, [pendingSelect, setNodes]);

  // isValidConnection + receptive highlighting BOTH delegate to canConnect via the
  // adapter — one rule, no divergence between what lights up and what connects.
  const isValidConnection = useCallback((conn) => connectionIsValid(graph, conn), [graph]);
  const connValue = useMemo(
    () => ({
      receptivityFor: (nodeId, portName, side) =>
        handleReceptivity(graph, connSource, { nodeId, portName, side }),
    }),
    [graph, connSource],
  );

  const onConnect = useCallback(
    (conn) => { const { from, to } = fromRfConnection(conn); onConnectEdge(from, to); },
    [onConnectEdge],
  );
  const onConnectStart = useCallback((_e, params) => {
    setConnSource({ nodeId: params.nodeId, handleId: params.handleId, handleType: params.handleType });
  }, []);

  // Release a port-drag over EMPTY canvas → the compatible-node spawn menu. The
  // dragged endpoint's type + side drive compatibleKinds; picking spawns the node
  // at the drop point AND auto-wires it (one undoable step in the parent).
  const onConnectEnd = useCallback((event, conn) => {
    setConnSource(null);
    if (!conn || !conn.fromHandle || conn.toHandle || conn.toNode) return; // landed on a handle/node
    const fromHandle = conn.fromHandle;
    const side = fromHandle.type === "source" ? "out" : "in";
    const node = graph.nodes.find((n) => n.id === fromHandle.nodeId);
    if (!node) return;
    const ports = side === "out" ? node.outputs : node.inputs;
    const draggedType = (ports || []).find((p) => p.name === fromHandle.id)?.type ?? "any";
    const { x: clientX, y: clientY } = pointerOf(event);
    setMenu({
      clientX, clientY, title: "Connect to",
      kinds: compatibleKinds(catalog.kinds, draggedType, side),
      pick: (entry) => {
        onSpawnFromPort(
          entry, screenToFlowPosition({ x: clientX, y: clientY }),
          { nodeId: fromHandle.nodeId, port: fromHandle.id, side }, draggedType,
        );
        setMenu(null);
      },
    });
  }, [graph, catalog, onSpawnFromPort, screenToFlowPosition]);

  // Detach / reroute: grabbing a connected handle drafts a wire from the STATIONARY
  // end (so compatible targets glow via the same receptivity rule); dropping on a
  // new handle reroutes (onReconnect), dropping on empty deletes (onReconnectEnd).
  const onReconnectStart = useCallback((_e, edge, handleType) => {
    reconnectDone.current = false;
    if (handleType === "target") setConnSource({ nodeId: edge.source, handleId: edge.sourceHandle, handleType: "source" });
    else setConnSource({ nodeId: edge.target, handleId: edge.targetHandle, handleType: "target" });
  }, []);
  const onReconnect = useCallback((oldEdge, conn) => {
    reconnectDone.current = true;
    const { from, to } = fromRfConnection(conn);
    onReroute(oldEdge.id, from, to);
  }, [onReroute]);
  const onReconnectEnd = useCallback((_e, edge, _handleType, conn) => {
    // Detach-to-empty deletes; a drop on an incompatible handle just reverts.
    if (!reconnectDone.current && conn && !conn.toHandle && !conn.toNode) onRemoveEdge(edge.id);
    reconnectDone.current = true;
    setConnSource(null);
  }, [onRemoveEdge]);

  // Commit the FINAL position(s) once, on drag stop — covers a multi-node drag.
  const onNodeDragStop = useCallback((_e, _node, dragged) => {
    onMoveNodes((dragged || []).map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })));
  }, [onMoveNodes]);

  const onDelete = useCallback(
    ({ nodes: dn, edges: de }) => onDeleteSelection((dn || []).map((n) => n.id), (de || []).map((e) => e.id)),
    [onDeleteSelection],
  );
  const onSelectionChange = useCallback(({ nodes: sel }) => onSelect((sel || []).map((n) => n.id)), [onSelect]);
  const onPaneClick = useCallback(() => setMenu(null), []);

  const openQuickAdd = useCallback((clientX, clientY) => {
    const hasInput = graph.nodes.some((n) => n.kind === "input");
    setMenu({
      clientX, clientY, title: "Add node",
      kinds: addableKinds(catalog.kinds, { hasInput }),
      pick: (entry) => { onAddNodeAt(entry, screenToFlowPosition({ x: clientX, y: clientY })); setMenu(null); },
    });
  }, [graph, catalog, onAddNodeAt, screenToFlowPosition]);

  const onDoubleClick = useCallback((e) => {
    if (!e.target?.classList?.contains("react-flow__pane")) return; // empty canvas only
    openQuickAdd(e.clientX, e.clientY);
  }, [openQuickAdd]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    const kind = e.dataTransfer.getData(PALETTE_DND_MIME);
    const entry = kind && catalog.byKind?.[kind];
    if (!entry) return;
    onAddNodeAt(entry, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  }, [catalog, onAddNodeAt, screenToFlowPosition]);
  const onDragOver = useCallback((e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }, []);

  const cursorClient = useCallback(() => {
    if (lastClientRef.current) return lastClientRef.current;
    const r = wrapperRef.current?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 200, y: 200 };
  }, []);

  // Palette CLICK (the convenience path) adds at the current viewport center — only
  // FlowCanvas knows the live transform, so it registers the center-add up to the
  // editor, which routes the palette button to it.
  useEffect(() => {
    if (!registerAddAtCenter) return;
    registerAddAtCenter((entry) => {
      const r = wrapperRef.current?.getBoundingClientRect();
      const c = r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 200, y: 200 };
      onAddNodeAt(entry, screenToFlowPosition(c));
    });
  }, [registerAddAtCenter, onAddNodeAt, screenToFlowPosition]);

  // Editor keyboard shortcuts. Ignored while a text field is focused (the name
  // input, the inspector, or the quick-add search) so typing is never hijacked.
  // Gated by `active`: a nested loop-body overlay sets the underlying canvas
  // inactive so only the topmost canvas reacts to ⌘Z / Tab / delete.
  useEffect(() => {
    if (!active || readOnly) return undefined;
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const meta = e.metaKey || e.ctrlKey;
      const sel = () => nodesRef.current.filter((n) => n.selected).map((n) => n.id);
      if (e.key === "Tab" && !meta) {
        e.preventDefault(); const p = cursorClient(); openQuickAdd(p.x, p.y);
      } else if (meta && (e.key === "z" || e.key === "Z")) {
        e.preventDefault(); if (e.shiftKey) onRedo(); else onUndo();
      } else if (meta && (e.key === "y" || e.key === "Y")) {
        e.preventDefault(); onRedo();
      } else if (meta && (e.key === "a" || e.key === "A")) {
        e.preventDefault(); setNodes((ns) => ns.map((n) => ({ ...n, selected: true })));
      } else if (meta && (e.key === "c" || e.key === "C")) {
        const ids = sel(); if (ids.length) { e.preventDefault(); onCopy(ids); }
      } else if (meta && (e.key === "v" || e.key === "V")) {
        e.preventDefault(); const p = cursorClient(); onPaste(screenToFlowPosition({ x: p.x, y: p.y }));
      } else if (meta && (e.key === "d" || e.key === "D")) {
        const ids = sel(); if (ids.length) { e.preventDefault(); onDuplicate(ids); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, readOnly, openQuickAdd, onUndo, onRedo, onCopy, onPaste, onDuplicate, screenToFlowPosition, setNodes, cursorClient]);

  // Read-only mode (the Runs view): the same renderer with every authoring
  // interaction off — no drag-move, connect, reconnect, marquee-select, delete, or
  // node-add, and the edit-only affordances (snap toggle, quick-add) hidden. Only
  // pan / zoom / fit / minimap survive, so a run is observed, never mutated.
  return (
    <div
      className={"wf-rf-canvas" + (readOnly ? " wf-rf-canvas--readonly" : "")}
      ref={wrapperRef}
      onMouseMove={(e) => { lastClientRef.current = { x: e.clientX, y: e.clientY }; }}
      onDoubleClick={readOnly ? undefined : onDoubleClick}
      onDrop={readOnly ? undefined : onDrop}
      onDragOver={readOnly ? undefined : onDragOver}
    >
      <WfConnectionContext.Provider value={connValue}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          defaultEdgeOptions={{ type: "wfEdge" }}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={readOnly ? undefined : onConnect}
          onConnectStart={readOnly ? undefined : onConnectStart}
          onConnectEnd={readOnly ? undefined : onConnectEnd}
          onReconnect={readOnly ? undefined : onReconnect}
          onReconnectStart={readOnly ? undefined : onReconnectStart}
          onReconnectEnd={readOnly ? undefined : onReconnectEnd}
          edgesReconnectable={!readOnly}
          reconnectRadius={16}
          isValidConnection={readOnly ? undefined : isValidConnection}
          onNodeDragStop={readOnly ? undefined : onNodeDragStop}
          onDelete={readOnly ? undefined : onDelete}
          onSelectionChange={readOnly ? undefined : onSelectionChange}
          onPaneClick={onPaneClick}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable={!readOnly}
          // Gated by `active`: RF's delete handler is document-level, so an inactive
          // underlying canvas (a loop-body overlay is open) must not also delete its
          // own selection when the user presses Delete in the overlay. Read-only
          // disables delete entirely.
          deleteKeyCode={!readOnly && active ? ["Delete", "Backspace"] : null}
          panOnDrag={readOnly ? true : [1, 2]}
          panActivationKeyCode="Space"
          selectionOnDrag={!readOnly}
          selectionMode={SelectionMode.Partial}
          snapToGrid={!readOnly && snap}
          snapGrid={[GRID, GRID]}
          onlyRenderVisibleElements
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          minZoom={0.2}
          maxZoom={2.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={GRID} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable className="wf-rf-minimap" />
          {!readOnly && (
            <Panel position="top-right">
              <button
                type="button"
                className={"wf-rf-snap" + (snap ? " wf-rf-snap--on" : "")}
                onClick={() => setSnap((s) => !s)}
                title="Snap nodes to the grid"
              >
                Snap to grid{snap ? " ✓" : ""}
              </button>
            </Panel>
          )}
        </ReactFlow>
      </WfConnectionContext.Provider>
      {!readOnly && menu && (
        <QuickAddMenu
          clientX={menu.clientX}
          clientY={menu.clientY}
          kinds={menu.kinds}
          title={menu.title}
          onPick={menu.pick}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

export function FlowCanvas(props) {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

export default FlowCanvas;
