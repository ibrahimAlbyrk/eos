// The interaction layer for the bespoke SVG renderer — the hand-built equivalent
// of every pointer/keyboard behavior the canvas needs, expressed over the
// renderer-agnostic viewport math + scene model. It owns ONLY ephemeral
// interaction state (viewport, selection, the in-flight gesture) and reports every
// committed change back through the SAME useGraphEditor callbacks the surface wires:
//
//   port drag → empty    → spawn menu (compatibleKinds, auto-wires)  [onSpawnFromPort]
//   port drag → handle   → onConnectEdge   (canConnect gates the commit in the model)
//   edge endpoint grab   → onReroute / onRemoveEdge (reconnect / detach-to-empty)
//   node drag            → onMoveNodes     (positions committed ONCE, on pointer-up)
//   marquee / shift-click → onSelect
//   Delete/Backspace     → onDeleteSelection
//   keyboard             → undo/redo/copy/paste/duplicate/select-all/quick-add
//
// DOM hit-testing drives gesture START: a pointerdown on a <circle class="wf-svg-
// handle"> IS the port grab, a pointerdown on a node <g data-node-id> IS the node
// grab — no geometry math for hit-testing. Only the pure pieces (zoom-at-cursor,
// marquee box, drop hit-test on pointer-up) use the gesture/viewport helpers.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { screenToFlow, snapViewport, fitViewport, DEFAULT_VIEWPORT } from "./viewport.js";
import { zoomAtPoint, wheelZoomFactor, normalizeRect, nodesInMarquee, snapToGrid } from "./canvasGestures.js";
import { nodesBounds } from "./sceneModel.js";
import { handleReceptivity } from "./connectionRules.js";
import { addableKinds, compatibleKinds } from "./quickAdd.js";
import { doubleClickAction } from "./containerNav.js";
import { PALETTE_DND_MIME } from "./Palette.jsx";

// A node-drag must travel a few px before it commits a move, so a plain click that
// happens to wiggle still reads as a selection, not a zero-distance move.
const DRAG_THRESHOLD = 3;

// The dot-grid pitch (matches the canvas GRID in styles.css) — snap-to-grid lands a
// dropped node on a multiple of this.
const GRID = 22;

// One Controls "+"/"−" press scales the viewport by this ratio, centered on the pane.
const ZOOM_STEP = 1.2;

// fitView reserves this fraction of the pane as a margin on each side (RF passes 0.2).
const FIT_PADDING = 0.12;

const NOOP = () => {};

// Pull the port descriptor a pointer landed on out of the hit element's dataset.
function handleDataset(el) {
  const g = el?.closest?.(".wf-svg-handle");
  if (!g) return null;
  return { nodeId: g.dataset.nodeId, port: g.dataset.port, side: g.dataset.side, type: g.dataset.type || "any" };
}

// The flow-space anchor of a node's port, from the scene (mirrors the live handle).
function anchorOf(scene, nodeId, portName, side) {
  const node = scene?.nodes?.find((n) => n.id === nodeId);
  if (!node) return null;
  const port = node.ports.find((p) => p.name === portName && p.side === side);
  return port ? port.anchor : null;
}

// Orient an edge output→input from the stationary endpoint + the handle dropped on
// (RF normalizes by handle role; we do the same by `side`). null when same role.
function orientEdge(stationary, dropHandle) {
  if (stationary.side === dropHandle.side) return { from: null, to: null };
  const out = stationary.side === "out" ? stationary : dropHandle;
  const inn = stationary.side === "in" ? stationary : dropHandle;
  return { from: { node: out.nodeId, port: out.port }, to: { node: inn.nodeId, port: inn.port } };
}

export function useGraphInteractions({
  graph, catalog = { kinds: [], byKind: {} }, scene, active = true, readOnly = false,
  pendingSelect, registerAddAtCenter,
  onSelect = NOOP, onConnectEdge = NOOP, onReroute = NOOP, onMoveNodes = NOOP,
  onDeleteSelection = NOOP, onRemoveEdge = NOOP, onAddNodeAt = NOOP, onSpawnFromPort = NOOP,
  onCopy = NOOP, onPaste = NOOP, onDuplicate = NOOP, onUndo = NOOP, onRedo = NOOP,
  onEnterNode = NOOP,
}) {
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT);
  const [selectedIds, setSelectedIds] = useState([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [pendingMove, setPendingMove] = useState(null); // { ids:Set, dx, dy } while dragging
  const [marquee, setMarquee] = useState(null);          // { x,y,w,h } in pane-screen px
  const [connect, setConnect] = useState(null);          // { connSource, anchor, cursor, reconnectEdgeId }
  const [menu, setMenu] = useState(null);                // quick-add / spawn menu
  const [paneSize, setPaneSize] = useState({ width: 0, height: 0 }); // surface px, tracked live
  const [snap, setSnap] = useState(false);               // snap-to-grid toggle (Controls chrome)

  const surfaceRef = useRef(null);
  const gestureRef = useRef(null);
  const lastClientRef = useRef(null);
  const spaceRef = useRef(false);
  // Hit RESOLVED at pointerdown, for double-click detection. WebKit redirects the
  // click/dblclick target to the pointer-capture element (the surface), so the
  // native dblclick can't read the node off e.target — we record it here instead,
  // where the hit-test is accurate (the same hit-test that drives gesture start).
  const downNodeRef = useRef(null);
  const downEdgeRef = useRef(false);

  // Refs mirror the latest values so the pointer handlers (reading live data
  // mid-gesture) never close over a stale viewport/scene/selection.
  const viewportRef = useRef(viewport); viewportRef.current = viewport;
  const sceneRef = useRef(scene); sceneRef.current = scene;
  const graphRef = useRef(graph); graphRef.current = graph;
  const selectedRef = useRef(selectedIds); selectedRef.current = selectedIds;
  const selectedEdgeRef = useRef(selectedEdgeId); selectedEdgeRef.current = selectedEdgeId;
  const paneSizeRef = useRef(paneSize); paneSizeRef.current = paneSize;
  const snapRef = useRef(snap); snapRef.current = snap;

  const paneRect = useCallback(() => surfaceRef.current?.getBoundingClientRect(), []);
  const clientToPane = useCallback((clientX, clientY, rect) => {
    const r = rect || paneRect();
    return r ? { x: clientX - r.left, y: clientY - r.top } : { x: clientX, y: clientY };
  }, [paneRect]);
  const clientToFlow = useCallback((clientX, clientY, rect) => {
    return screenToFlow(viewportRef.current, clientToPane(clientX, clientY, rect));
  }, [clientToPane]);

  const applySelection = useCallback((ids) => {
    setSelectedIds(ids);
    setSelectedEdgeId(null);
    onSelect(ids);
  }, [onSelect]);

  // Programmatic selection after add / spawn / paste / duplicate — mirror the ids
  // the parent just created (driven by pendingSelect from useGraphEditor).
  useEffect(() => {
    if (!pendingSelect || pendingSelect.length === 0) return;
    setSelectedIds(pendingSelect);
    setSelectedEdgeId(null);
    onSelect(pendingSelect);
  }, [pendingSelect, onSelect]);

  // Palette CLICK adds at the current viewport center — only the renderer knows the
  // live transform, so it registers a center-add the editor routes the button to.
  useEffect(() => {
    if (!registerAddAtCenter) return;
    registerAddAtCenter((entry) => {
      const r = paneRect();
      const center = r ? { x: r.width / 2, y: r.height / 2 } : { x: 200, y: 200 };
      onAddNodeAt(entry, screenToFlow(viewportRef.current, center));
    });
  }, [registerAddAtCenter, onAddNodeAt, paneRect]);

  // ---- the spawn / quick-add menus (positioned at the cursor, fixed overlay) ----
  const openQuickAdd = useCallback((clientX, clientY) => {
    const hasInput = (graphRef.current.nodes || []).some((n) => n.kind === "input");
    setMenu({
      clientX, clientY, title: "Add node",
      kinds: addableKinds(catalog.kinds, { hasInput }),
      pick: (entry) => { onAddNodeAt(entry, clientToFlow(clientX, clientY)); setMenu(null); },
    });
  }, [catalog, onAddNodeAt, clientToFlow]);

  const openSpawnMenu = useCallback((clientX, clientY, source) => {
    setMenu({
      clientX, clientY, title: "Connect to",
      kinds: compatibleKinds(catalog.kinds, source.type, source.side),
      pick: (entry) => {
        onSpawnFromPort(entry, clientToFlow(clientX, clientY),
          { nodeId: source.nodeId, port: source.port, side: source.side }, source.type);
        setMenu(null);
      },
    });
  }, [catalog, onSpawnFromPort, clientToFlow]);

  // Drop a port-drag: a handle under the cursor connects/reroutes; empty canvas
  // spawns a compatible node (new connect) or detaches the edge (reconnect).
  const resolveConnectDrop = useCallback((g, clientX, clientY) => {
    const dropEl = typeof document !== "undefined" ? document.elementFromPoint(clientX, clientY) : null;
    const dropHandle = handleDataset(dropEl);
    if (dropHandle && dropHandle.nodeId) {
      const { from, to } = orientEdge(g.stationary, dropHandle);
      if (from && to) {
        if (g.reconnectEdgeId) onReroute(g.reconnectEdgeId, from, to);
        else onConnectEdge(from, to);
      }
      return;
    }
    if (g.reconnectEdgeId) { onRemoveEdge(g.reconnectEdgeId); return; } // detach-to-empty
    openSpawnMenu(clientX, clientY, g.stationary);
  }, [onReroute, onConnectEdge, onRemoveEdge, openSpawnMenu]);

  // ---- gesture lifecycle ----
  const beginConnect = useCallback((connSource, stationary, anchor, clientX, clientY, reconnectEdgeId) => {
    gestureRef.current = { type: "connect", connSource, stationary, reconnectEdgeId: reconnectEdgeId || null };
    setConnect({ connSource, stationary, anchor, cursor: clientToFlow(clientX, clientY), reconnectEdgeId: reconnectEdgeId || null });
  }, [clientToFlow]);

  const onPointerDown = useCallback((e) => {
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    const rect = paneRect();
    lastClientRef.current = { x: e.clientX, y: e.clientY };
    const isSecondary = e.button === 1 || e.button === 2;
    const target = e.target;

    // Record the hit for double-click detection (capture-independent — see
    // downNodeRef). A node body is `.wf-svg-node`; a port handle also carries
    // data-node-id but is not a node body, so a double-press on a port never enters.
    const downNodeEl = target.closest?.("[data-node-id]");
    downNodeRef.current = downNodeEl && downNodeEl.classList.contains("wf-svg-node") ? downNodeEl.dataset.nodeId : null;
    downEdgeRef.current = !downNodeRef.current && Boolean(target.closest?.(".wf-svg-edge-hit"));

    // Read-only (Runs view + Library detail): a click SELECTS a node or edge so the
    // locked inspector can show it; pan + wheel-zoom still work. No edit gesture ever
    // arms (no drag/connect/reconnect/marquee/add) — pan is the only drag.
    if (readOnly) {
      if (!isSecondary) {
        const nodeEl = target.closest?.("[data-node-id]");
        if (nodeEl && nodeEl.classList.contains("wf-svg-node")) {
          applySelection([nodeEl.dataset.nodeId]);
        } else {
          const edgeEl = target.closest?.(".wf-svg-edge-hit");
          if (edgeEl) { setSelectedIds([]); setSelectedEdgeId(edgeEl.dataset.edgeId); onSelect([]); }
        }
      }
      surfaceRef.current?.setPointerCapture?.(e.pointerId);
      gestureRef.current = { type: "pan", last: { x: e.clientX, y: e.clientY } };
      return;
    }

    // 1) port handle → start a NEW connection (live preview + receptivity glow).
    const handle = handleDataset(target);
    if (handle) {
      const anchor = anchorOf(sceneRef.current, handle.nodeId, handle.port, handle.side);
      if (anchor) {
        const connSource = {
          nodeId: handle.nodeId, handleId: handle.port,
          handleType: handle.side === "out" ? "source" : "target",
        };
        surfaceRef.current?.setPointerCapture?.(e.pointerId);
        beginConnect(connSource, handle, anchor, e.clientX, e.clientY, null);
      }
      return;
    }

    // 2) edge endpoint grab → reconnect that end (the STATIONARY end drafts the wire).
    const recon = target.closest?.(".wf-svg-reconnect");
    if (recon) {
      const edgeId = recon.dataset.edgeId;
      const movingEnd = recon.dataset.end; // "source" | "target"
      const edge = (graphRef.current.edges || []).find((ed) => ed.id === edgeId);
      if (edge) {
        const stationary = movingEnd === "source"
          ? { nodeId: edge.to.node, port: edge.to.port, side: "in", type: "any" }
          : { nodeId: edge.from.node, port: edge.from.port, side: "out", type: "any" };
        const anchor = anchorOf(sceneRef.current, stationary.nodeId, stationary.port, stationary.side);
        if (anchor) {
          const connSource = {
            nodeId: stationary.nodeId, handleId: stationary.port,
            handleType: stationary.side === "out" ? "source" : "target",
          };
          surfaceRef.current?.setPointerCapture?.(e.pointerId);
          beginConnect(connSource, stationary, anchor, e.clientX, e.clientY, edgeId);
        }
      }
      return;
    }

    // 3) node body → select (+ shift toggle) and arm a node drag.
    const nodeEl = target.closest?.("[data-node-id]");
    if (nodeEl && nodeEl.classList.contains("wf-svg-node") && !isSecondary) {
      const id = nodeEl.dataset.nodeId;
      const cur = selectedRef.current;
      const next = e.shiftKey
        ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])
        : (cur.includes(id) ? cur : [id]);
      applySelection(next);
      const ids = new Set(next.length ? next : [id]);
      const basePos = new Map();
      for (const n of graphRef.current.nodes) if (ids.has(n.id)) basePos.set(n.id, { x: n.ui.x, y: n.ui.y });
      gestureRef.current = {
        type: "node", ids, basePos, startClient: { x: e.clientX, y: e.clientY },
        zoom: viewportRef.current.zoom, moved: false,
      };
      surfaceRef.current?.setPointerCapture?.(e.pointerId);
      return;
    }

    // 4) edge body → select it (Delete removes it). No drag.
    const edgeEl = target.closest?.(".wf-svg-edge-hit");
    if (edgeEl && !isSecondary) {
      setSelectedIds([]);
      setSelectedEdgeId(edgeEl.dataset.edgeId);
      onSelect([]);
      gestureRef.current = null;
      return;
    }

    // 5) empty canvas → middle/right or Space+left pans; plain left marquees.
    surfaceRef.current?.setPointerCapture?.(e.pointerId);
    if (isSecondary || (e.button === 0 && spaceRef.current)) {
      gestureRef.current = { type: "pan", last: { x: e.clientX, y: e.clientY } };
    } else {
      const pane = clientToPane(e.clientX, e.clientY, rect);
      gestureRef.current = { type: "marquee", startPane: pane, rect, additive: e.shiftKey, moved: false };
      setMarquee({ x: pane.x, y: pane.y, w: 0, h: 0 });
    }
  }, [readOnly, paneRect, clientToPane, beginConnect, applySelection, onSelect]);

  const onPointerMove = useCallback((e) => {
    lastClientRef.current = { x: e.clientX, y: e.clientY };
    const g = gestureRef.current;
    if (!g) return;
    if (g.type === "pan") {
      const dx = e.clientX - g.last.x;
      const dy = e.clientY - g.last.y;
      g.last = { x: e.clientX, y: e.clientY };
      setViewport((vp) => ({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom }));
    } else if (g.type === "node") {
      if (!g.moved && Math.hypot(e.clientX - g.startClient.x, e.clientY - g.startClient.y) < DRAG_THRESHOLD) return;
      g.moved = true;
      setPendingMove({
        ids: g.ids,
        dx: (e.clientX - g.startClient.x) / g.zoom,
        dy: (e.clientY - g.startClient.y) / g.zoom,
        snap: snapRef.current,
      });
    } else if (g.type === "marquee") {
      g.moved = true;
      setMarquee(normalizeRect(g.startPane, clientToPane(e.clientX, e.clientY, g.rect)));
    } else if (g.type === "connect") {
      const cursor = clientToFlow(e.clientX, e.clientY);
      setConnect((c) => (c ? { ...c, cursor } : c));
    }
  }, [clientToPane, clientToFlow]);

  const endGesture = useCallback((e) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    try { surfaceRef.current?.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
    if (!g) return;
    if (g.type === "pan") {
      setViewport((vp) => snapViewport(vp));
    } else if (g.type === "node") {
      if (g.moved) {
        const dx = (e.clientX - g.startClient.x) / g.zoom;
        const dy = (e.clientY - g.startClient.y) / g.zoom;
        const doSnap = snapRef.current;
        const moves = [];
        for (const [id, p] of g.basePos) {
          const x = p.x + dx;
          const y = p.y + dy;
          moves.push({ id, x: doSnap ? snapToGrid(x, GRID) : x, y: doSnap ? snapToGrid(y, GRID) : y });
        }
        onMoveNodes(moves);
      }
      setPendingMove(null);
    } else if (g.type === "marquee") {
      setMarquee(null);
      if (g.moved) {
        const startFlow = screenToFlow(viewportRef.current, g.startPane);
        const endFlow = clientToFlow(e.clientX, e.clientY, g.rect);
        const hits = nodesInMarquee(sceneRef.current.nodes, normalizeRect(startFlow, endFlow));
        applySelection(g.additive ? Array.from(new Set([...selectedRef.current, ...hits])) : hits);
      } else {
        if (selectedRef.current.length) applySelection([]);
        setSelectedEdgeId(null);
        setMenu(null);
      }
    } else if (g.type === "connect") {
      resolveConnectDrop(g, e.clientX, e.clientY);
      setConnect(null);
    }
  }, [onMoveNodes, applySelection, clientToFlow, resolveConnectDrop]);

  const onPointerCancel = useCallback((e) => {
    gestureRef.current = null;
    try { surfaceRef.current?.releasePointerCapture?.(e.pointerId); } catch { /* noop */ }
    setPendingMove(null); setMarquee(null); setConnect(null);
  }, []);

  // Double-click on a node ENTERS its nested content (a loop's body sub-graph) —
  // the parent decides which kinds are containers, so a non-container double-click
  // is a no-op. This works in read-only too (view the inner nodes). Double-click on
  // EMPTY canvas stays quick-add (edit only); on an edge it does nothing. The node
  // is read from the pointerdown hit (downNodeRef), NOT e.target — under pointer
  // capture WebKit reports e.target as the surface, so e.target can't identify it.
  const onDoubleClick = useCallback((e) => {
    const action = doubleClickAction({ downNodeId: downNodeRef.current, readOnly, onEdge: downEdgeRef.current });
    if (action.type === "enter") onEnterNode(action.nodeId);
    else if (action.type === "quickAdd") openQuickAdd(e.clientX, e.clientY);
  }, [readOnly, openQuickAdd, onEnterNode]);

  // Palette HTML5 drop — resolve the kind, add at the drop point.
  const onDrop = useCallback((e) => {
    if (readOnly) return;
    e.preventDefault();
    const kind = e.dataTransfer.getData(PALETTE_DND_MIME);
    const entry = kind && catalog.byKind?.[kind];
    if (!entry) return;
    onAddNodeAt(entry, clientToFlow(e.clientX, e.clientY));
  }, [readOnly, catalog, onAddNodeAt, clientToFlow]);
  const onDragOver = useCallback((e) => {
    if (readOnly) return;
    e.preventDefault(); e.dataTransfer.dropEffect = "copy";
  }, [readOnly]);

  // Suppress the native context menu on the canvas. React Flow did this whenever
  // right-drag panning was enabled (panOnDrag included button 2); right-button pans
  // here too (in both editor and read-only), so without this a right-click — or the
  // end of a right-drag pan — pops the browser menu.
  const onContextMenu = useCallback((e) => { e.preventDefault(); }, []);

  // Track Space held → Space+left-drag pans (RF's panActivationKeyCode="Space").
  useEffect(() => {
    const down = (e) => { if (e.code === "Space" || e.key === " ") spaceRef.current = true; };
    const up = (e) => { if (e.code === "Space" || e.key === " ") spaceRef.current = false; };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  // Wheel-zoom — attached as a NON-passive native listener so preventDefault stops
  // the page scroll and the zoom anchors on the cursor (zoomAtPoint).
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const pane = { x: e.clientX - r.left, y: e.clientY - r.top };
      setViewport((vp) => zoomAtPoint(vp, pane, wheelZoomFactor(e.deltaY)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Track the surface size so fitView / minimap / off-viewport culling work off the
  // live pane dimensions (not a stale read). ResizeObserver covers layout changes
  // (splitter drag, window resize, loop-overlay open) without a render loop.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return undefined;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setPaneSize((prev) => (prev.width === r.width && prev.height === r.height ? prev : { width: r.width, height: r.height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const paneCenter = useCallback(() => {
    const ps = paneSizeRef.current;
    return { x: ps.width / 2, y: ps.height / 2 };
  }, []);

  // Controls chrome: frame all nodes (fit), step-zoom about the pane center. fitView
  // snaps the result so glyphs land crisp at rest, like a pan end.
  const fitView = useCallback(() => {
    const bounds = nodesBounds(sceneRef.current?.nodes);
    const ps = paneSizeRef.current;
    if (!bounds || ps.width <= 0 || ps.height <= 0) return;
    setViewport(snapViewport(fitViewport(bounds, ps, { padding: FIT_PADDING })));
  }, []);
  const zoomIn = useCallback(() => setViewport((vp) => snapViewport(zoomAtPoint(vp, paneCenter(), ZOOM_STEP))), [paneCenter]);
  const zoomOut = useCallback(() => setViewport((vp) => snapViewport(zoomAtPoint(vp, paneCenter(), 1 / ZOOM_STEP))), [paneCenter]);

  // Recenter the viewport on a flow point (minimap click/drag) at the current zoom.
  const centerOn = useCallback((flowPoint) => {
    const ps = paneSizeRef.current;
    setViewport((vp) => snapViewport({ x: ps.width / 2 - flowPoint.x * vp.zoom, y: ps.height / 2 - flowPoint.y * vp.zoom, zoom: vp.zoom }));
  }, []);

  // Open framed, not at 0,0 (Phase 1's gap): once the pane is measured and the scene
  // has nodes, run fitView a single time. The didFit guard makes it one-shot so later
  // graph edits / pans are never yanked back to a frame.
  const didFitRef = useRef(false);
  useEffect(() => {
    if (didFitRef.current) return;
    if (paneSize.width <= 0 || paneSize.height <= 0) return;
    if (!nodesBounds(scene?.nodes)) return;
    didFitRef.current = true;
    fitView();
  }, [paneSize, scene, fitView]);

  // Editor keyboard shortcuts. Ignored while a text
  // field is focused; gated by `active` (a loop-body overlay deactivates the canvas
  // beneath it) and disabled in read-only mode.
  useEffect(() => {
    if (!active || readOnly) return undefined;
    const cursorClient = () => {
      if (lastClientRef.current) return lastClientRef.current;
      const r = paneRect();
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 200, y: 200 };
    };
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const meta = e.metaKey || e.ctrlKey;
      if (e.key === "Tab" && !meta) {
        e.preventDefault(); const p = cursorClient(); openQuickAdd(p.x, p.y);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedRef.current.length || selectedEdgeRef.current) {
          e.preventDefault();
          onDeleteSelection(selectedRef.current, selectedEdgeRef.current ? [selectedEdgeRef.current] : []);
          setSelectedEdgeId(null);
        }
      } else if (meta && (e.key === "z" || e.key === "Z")) {
        e.preventDefault(); if (e.shiftKey) onRedo(); else onUndo();
      } else if (meta && (e.key === "y" || e.key === "Y")) {
        e.preventDefault(); onRedo();
      } else if (meta && (e.key === "a" || e.key === "A")) {
        e.preventDefault(); applySelection(graphRef.current.nodes.map((n) => n.id));
      } else if (meta && (e.key === "c" || e.key === "C")) {
        if (selectedRef.current.length) { e.preventDefault(); onCopy(selectedRef.current); }
      } else if (meta && (e.key === "v" || e.key === "V")) {
        e.preventDefault(); const p = cursorClient(); onPaste(clientToFlow(p.x, p.y));
      } else if (meta && (e.key === "d" || e.key === "D")) {
        if (selectedRef.current.length) { e.preventDefault(); onDuplicate(selectedRef.current); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, readOnly, openQuickAdd, onDeleteSelection, onRedo, onUndo, applySelection,
      onCopy, onPaste, onDuplicate, clientToFlow, paneRect]);

  // Receptivity for a candidate handle during a live connect — same single rule
  // (canConnect via handleReceptivity) that gates the eventual drop, surfaced ahead.
  const connSource = connect?.connSource || null;
  const receptivityFor = useMemo(() => {
    if (!connSource) return () => null;
    return (nodeId, portName, side) => handleReceptivity(graphRef.current, connSource, { nodeId, portName, side });
  }, [connSource]);

  return {
    surfaceRef, viewport, setViewport,
    selectedIds, selectedEdgeId,
    pendingMove, marquee, connect, receptivityFor,
    menu, setMenu,
    paneSize, snap, setSnap, fitView, zoomIn, zoomOut, centerOn,
    bind: { onPointerDown, onPointerMove, onPointerUp: endGesture, onPointerCancel, onDoubleClick, onDrop, onDragOver, onContextMenu },
  };
}
