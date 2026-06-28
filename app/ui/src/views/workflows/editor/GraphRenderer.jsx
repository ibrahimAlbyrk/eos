// The bespoke SVG renderer — the sole, blur-free workflow canvas (mounted by
// GraphEditorSurface and the read-only RunCanvas). It reports through the
// useGraphEditor callbacks the surface wires, so the editor and the Runs view share
// one renderer.
//
// Why SVG zooms crisp where the HTML cards blur: the whole graph is ONE <g> under a
// single matrix() transform; SVG is re-rasterized by the vector engine per frame
// (no cached-bitmap upscaling), exactly like the edges that never blurred (§1 of
// CANVAS_RENDER_DESIGN.md). Nodes are SVG primitives (<rect>/<text>/<circle>) so
// there is no DOM box to composite; theming rides the SAME tokens — the category
// rail reuses the .wf-rf-node--cat-* → --k mapping verbatim, status/receptivity get
// SVG fill/stroke analogues in styles.css.
//
// Everything is driven by toScene(graph,{nodeStates}); the interaction layer lives
// in useGraphInteractions; DOM pointer-events do the hit-testing (a pointerdown on a
// <circle class="wf-svg-handle"> IS the port grab).
import { memo, useMemo } from "react";
import { viewportMatrix, visibleFlowRect } from "./viewport.js";
import { gridOpacity, gridGap } from "./gridFade.js";
import { rectsIntersect, snapToGrid, edgesForDisplay } from "./canvasGestures.js";
import { toScene, bezierPath, reconnectPoints, NODE_W, HEADER_H } from "./sceneModel.js";
import { KindIcon } from "./KindIcon.jsx";
import { QuickAddMenu } from "./QuickAddMenu.jsx";
import { Minimap } from "./Minimap.jsx";
import { useGraphInteractions } from "./useGraphInteractions.js";

const GRID = 22;
// Off-viewport culling margin: render nodes within this flow-px halo of the visible
// rect so a node partly past the edge never pops in/out at the boundary.
const CULL_MARGIN = NODE_W;
const HANDLE_R = 5;
const HANDLE_HIT_R = 9;       // generous transparent grab/drop halo around each dot
const RECONNECT_R = 5;
const LABEL_X = 30;           // label starts right of the header icon
const KIND_X = NODE_W - 10;   // kind / status text is right-aligned here

const EMPTY_NODE_STATES = {};
const NOOP = () => {};

// One port = a transparent hit halo + the visible dot, grouped under the data-attrs
// the interaction layer reads on pointerdown/drop. Receptivity (compatible/reject)
// rides a class on the group, set from the SAME canConnect rule as the drop gate.
function PortHandle({ nodeId, port, box, receptivity }) {
  const cls =
    "wf-svg-handle" +
    (receptivity === "receptive" ? " wf-svg-handle--receptive" : "") +
    (receptivity === "reject" ? " wf-svg-handle--reject" : "");
  return (
    <g
      className={cls}
      data-node-id={nodeId}
      data-port={port.name}
      data-side={port.side}
      data-type={port.type}
      transform={`translate(${port.anchor.x - box.x},${port.anchor.y - box.y})`}
    >
      <circle className="wf-svg-handle__hit" r={HANDLE_HIT_R} />
      <circle className="wf-svg-handle__dot" data-type={port.type} r={HANDLE_R} />
    </g>
  );
}

const SvgNode = memo(function SvgNode({ node, selected, receptivityFor }) {
  const { box } = node;
  const inputs = node.ports.filter((p) => p.side === "in");
  const outputs = node.ports.filter((p) => p.side === "out");
  const cls =
    "wf-svg-node wf-rf-node--cat-" + node.category +
    (selected ? " wf-svg-node--selected" : "") +
    (node.status ? " wf-svg-node--" + node.status : "");

  return (
    <g className={cls} data-node-id={node.id} transform={`translate(${box.x},${box.y})`}>
      <rect className="wf-svg-node__card" x="0" y="0" width={NODE_W} height={box.h} rx="10" />
      <rect className="wf-svg-node__rail" x="0" y="1" width="3" height={box.h - 2} rx="1.5" />
      <line className="wf-svg-node__divider" x1="0" y1={HEADER_H} x2={NODE_W} y2={HEADER_H} />

      <g transform="translate(9,7)"><KindIcon kind={node.kind} /></g>
      <text className="wf-svg-node__label" x={LABEL_X} y={HEADER_H / 2} dominantBaseline="central" clipPath="url(#wf-svg-label-clip)">
        {node.label}
      </text>
      {node.status ? (
        <text className={"wf-svg-node__status wf-svg-node__status--" + node.status} x={KIND_X} y={HEADER_H / 2} dominantBaseline="central" textAnchor="end">
          {node.status}
        </text>
      ) : (
        <text className="wf-svg-node__kind" x={KIND_X} y={HEADER_H / 2} dominantBaseline="central" textAnchor="end">
          {node.kind}
        </text>
      )}

      {inputs.map((p) => (
        <text key={"li-" + p.name} className="wf-svg-port__name" x="12" y={p.anchor.y - box.y} dominantBaseline="central" textAnchor="start">
          {p.name}<tspan className="wf-svg-port__type" dx="4">{p.type}</tspan>
        </text>
      ))}
      {outputs.map((p) => (
        <text key={"lo-" + p.name} className="wf-svg-port__name" x={NODE_W - 12} y={p.anchor.y - box.y} dominantBaseline="central" textAnchor="end">
          <tspan className="wf-svg-port__type" dx="0">{p.type}</tspan><tspan dx="4">{p.name}</tspan>
        </text>
      ))}

      {node.ports.map((p) => (
        <PortHandle key={p.side + "-" + p.name} nodeId={node.id} port={p} box={box}
          receptivity={receptivityFor(node.id, p.name, p.side)} />
      ))}
    </g>
  );
});

const SvgEdge = memo(function SvgEdge({ edge, selected }) {
  if (!edge.path) return null;
  const { d } = edge.path;
  return (
    <g className={"wf-svg-edge-group" + (selected ? " wf-svg-edge-group--selected" : "")}>
      <path className={"wf-svg-edge" + (selected ? " wf-svg-edge--selected" : "")} data-type={edge.type} d={d} fill="none" />
      <path className="wf-svg-edge-hit" data-edge-id={edge.id} d={d} fill="none" />
      {edge.flow && <path className="wf-svg-edge__flow" d={d} fill="none" />}
    </g>
  );
});

// A reconnect grab handle, sitting EXACTLY on an edge endpoint (port anchor). Rendered
// in a layer ABOVE the nodes so it paints over — and takes the pointer ahead of — the
// port handle underneath: a press here reconnects the edge (useGraphInteractions reads
// data-edge-id / data-end), while a press on a bare port still starts a new connection.
// The transparent hit halo (HANDLE_HIT_R) matches the port handle's grab radius.
const ReconnectHandle = memo(function ReconnectHandle({ edgeId, end, point }) {
  return (
    <g className="wf-svg-reconnect" data-edge-id={edgeId} data-end={end} transform={`translate(${point.x},${point.y})`}>
      <circle className="wf-svg-reconnect__hit" r={HANDLE_HIT_R} />
      <circle className="wf-svg-reconnect__ring" r={RECONNECT_R} />
    </g>
  );
});

function GraphRenderer({
  graph, catalog = { kinds: [], byKind: {} }, nodeStates = EMPTY_NODE_STATES,
  active = true, readOnly = false, pendingSelect, registerAddAtCenter,
  onSelect = NOOP, onConnectEdge = NOOP, onReroute = NOOP, onMoveNodes = NOOP,
  onDeleteSelection = NOOP, onRemoveEdge = NOOP, onAddNodeAt = NOOP, onSpawnFromPort = NOOP,
  onCopy = NOOP, onPaste = NOOP, onDuplicate = NOOP, onUndo = NOOP, onRedo = NOOP,
  onEnterNode = NOOP,
}) {
  // Base scene (committed positions) feeds the interaction layer's geometry; it is
  // stable across pan/zoom (deps are graph/nodeStates only), so the memoized node
  // subtree skips re-rendering during a pan — only the <g> matrix attribute changes.
  const baseScene = useMemo(() => toScene(graph, { nodeStates }), [graph, nodeStates]);

  const {
    surfaceRef, viewport, selectedIds, selectedEdgeId,
    pendingMove, marquee, connect, receptivityFor, menu, setMenu, bind,
    paneSize, snap, setSnap, fitView, zoomIn, zoomOut, centerOn,
  } = useGraphInteractions({
    graph, catalog, scene: baseScene, active, readOnly, pendingSelect, registerAddAtCenter,
    onSelect, onConnectEdge, onReroute, onMoveNodes, onDeleteSelection, onRemoveEdge,
    onAddNodeAt, onSpawnFromPort, onCopy, onPaste, onDuplicate, onUndo, onRedo, onEnterNode,
  });

  // While a node drag is in flight, paint from a graph with the offset applied so
  // the dragged nodes AND their incident edges move live (re-routed by the scene
  // model); commit happens once, on pointer-up, via onMoveNodes.
  const displayScene = useMemo(() => {
    if (!pendingMove) return baseScene;
    const ids = pendingMove.ids;
    const moved = {
      ...graph,
      nodes: graph.nodes.map((n) => {
        if (!ids.has(n.id)) return n;
        const x = n.ui.x + pendingMove.dx;
        const y = n.ui.y + pendingMove.dy;
        return { ...n, ui: pendingMove.snap ? { x: snapToGrid(x, GRID), y: snapToGrid(y, GRID) } : { x, y } };
      }),
    };
    return toScene(moved, { nodeStates });
  }, [pendingMove, baseScene, graph, nodeStates]);

  // Off-viewport culling (RF's onlyRenderVisibleElements): paint only nodes whose box
  // intersects the visible flow rect (+margin). Cheap and correct; edges stay (a wire
  // crossing the viewport between two off-screen nodes must still draw). Falls back to
  // all nodes until the pane is measured.
  const visibleNodes = useMemo(() => {
    if (!paneSize.width || !paneSize.height) return displayScene.nodes;
    const v = visibleFlowRect(viewport, paneSize);
    const rect = { x: v.x - CULL_MARGIN, y: v.y - CULL_MARGIN, w: v.w + CULL_MARGIN * 2, h: v.h + CULL_MARGIN * 2 };
    return displayScene.nodes.filter((n) => rectsIntersect(n.box, rect));
  }, [displayScene.nodes, viewport, paneSize]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  // Background dot-grid: a level-of-detail gap keeps the dots' screen spacing
  // roughly stable (no dense mass when zoomed out), and the opacity fades them out
  // as you zoom out / resolves them in as you zoom in (RF's background feel). Both
  // are pure zoom→value maps; opacity rides a plain SVG attribute so the dots stay
  // sharp (no blur / layer-promotion).
  const tile = gridGap(viewport.zoom, GRID) * viewport.zoom;
  const gridFade = gridOpacity(viewport.zoom);

  let previewD = null;
  if (connect) {
    const { anchor, cursor, stationary } = connect;
    previewD = stationary.side === "out" ? bezierPath(anchor, cursor).d : bezierPath(cursor, anchor).d;
  }

  // Reconnect handles show on the SELECTED edge (the one being reconnected is hidden
  // mid-drag, like its wire). Their points are the edge's exact endpoints.
  const reconnectEdge = selectedEdgeId
    ? displayScene.edges.find((e) => e.id === selectedEdgeId && e.path && e.id !== connect?.reconnectEdgeId)
    : null;
  const reconPts = reconnectEdge ? reconnectPoints(reconnectEdge) : null;

  return (
    <div
      className={"wf-rf-canvas wf-svg-canvas" + (readOnly ? " wf-rf-canvas--readonly" : "")}
      ref={surfaceRef}
      {...bind}
    >
      <svg className="wf-svg" width="100%" height="100%">
        <defs>
          <pattern
            id="wf-svg-grid"
            patternUnits="userSpaceOnUse"
            width={tile}
            height={tile}
            patternTransform={`translate(${viewport.x},${viewport.y})`}
          >
            <circle className="wf-svg__grid-dot" cx={tile / 2} cy={tile / 2} r="1" />
          </pattern>
          <clipPath id="wf-svg-label-clip">
            <rect x={LABEL_X - 2} y="0" width={NODE_W - LABEL_X - 44} height={HEADER_H} />
          </clipPath>
        </defs>

        <rect className="wf-svg__bg" x="0" y="0" width="100%" height="100%" fill="url(#wf-svg-grid)" opacity={gridFade} />

        <g transform={viewportMatrix(viewport)}>
          <g className="wf-svg__edges">
            {edgesForDisplay(displayScene.edges, connect?.reconnectEdgeId).map((e) => (
              <SvgEdge key={e.id} edge={e} selected={selectedEdgeId === e.id} />
            ))}
          </g>
          <g className="wf-svg__nodes">
            {visibleNodes.map((n) => (
              <SvgNode key={n.id} node={n} selected={selectedSet.has(n.id)} receptivityFor={receptivityFor} />
            ))}
          </g>
          {!readOnly && reconPts && (
            <g className="wf-svg__reconnects">
              <ReconnectHandle edgeId={reconnectEdge.id} end="source" point={reconPts.source} />
              <ReconnectHandle edgeId={reconnectEdge.id} end="target" point={reconPts.target} />
            </g>
          )}
          {previewD && <path className="wf-svg-connectionline" d={previewD} fill="none" />}
        </g>

        {marquee && (
          <rect className="wf-svg-marquee" x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} />
        )}
      </svg>

      {/* Controls widget (RF's Controls): zoom in / out / fit. Survives read-only. */}
      <div className="wf-svg-controls">
        <button type="button" className="wf-svg-controls__btn" onClick={zoomIn} title="Zoom in" aria-label="Zoom in">+</button>
        <button type="button" className="wf-svg-controls__btn" onClick={zoomOut} title="Zoom out" aria-label="Zoom out">−</button>
        <button type="button" className="wf-svg-controls__btn" onClick={fitView} title="Fit view" aria-label="Fit view">⤢</button>
      </div>

      {/* Snap-to-grid toggle — an edit affordance, hidden in read-only (matches RF). */}
      {!readOnly && (
        <div className="wf-svg-panel wf-svg-panel--top-right">
          <button
            type="button"
            className={"wf-rf-snap" + (snap ? " wf-rf-snap--on" : "")}
            onClick={() => setSnap((s) => !s)}
            title="Snap nodes to the grid"
          >
            Snap to grid{snap ? " ✓" : ""}
          </button>
        </div>
      )}

      <Minimap scene={displayScene} viewport={viewport} paneSize={paneSize} onNavigate={centerOn} />

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

export default GraphRenderer;
