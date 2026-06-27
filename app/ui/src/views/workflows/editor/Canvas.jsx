// The graph canvas: a scrollable surface holding draggable NodeCards with SVG
// bezier edges between their typed ports. Edge geometry comes from the shared
// portAnchor() so wires track the rendered handles. Node drag uses window pointer
// listeners while a header is held; clicking the background deselects + cancels a
// pending connection. Edges are click-to-remove.
import { useEffect, useRef, useState } from "react";
import { NodeCard } from "./NodeCard.jsx";
import { portAnchor } from "./geometry.js";

function anchorFor(node, side, portName) {
  const ports = side === "out" ? node.outputs : node.inputs;
  const idx = Math.max(0, (ports || []).findIndex((p) => p.name === portName));
  return portAnchor(node, side, idx);
}

function bezier(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

export function Canvas({
  graph, selectedId, nodeStates, pendingPort,
  onSelect, onMoveNode, onPortClick, onRemoveEdge, onBackgroundClick,
}) {
  const surfaceRef = useRef(null);
  const [drag, setDrag] = useState(null); // { id, offX, offY }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  function surfacePoint(clientX, clientY) {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return { x: clientX, y: clientY };
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function onHeaderPointerDown(e, id) {
    e.stopPropagation();
    const node = byId.get(id);
    if (!node) return;
    const p = surfacePoint(e.clientX, e.clientY);
    setDrag({ id, offX: p.x - node.ui.x, offY: p.y - node.ui.y });
    onSelect(id);
  }

  useEffect(() => {
    if (!drag) return undefined;
    const move = (e) => {
      const p = surfacePoint(e.clientX, e.clientY);
      onMoveNode(drag.id, Math.max(0, p.x - drag.offX), Math.max(0, p.y - drag.offY));
    };
    const up = () => setDrag(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    // surfacePoint/onMoveNode are stable enough for the drag lifetime; re-binding
    // only on drag start/end is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag]);

  return (
    <div
      className="wfe-canvas"
      ref={surfaceRef}
      onPointerDown={(e) => { if (e.target === e.currentTarget) onBackgroundClick(); }}
    >
      <svg className="wfe-edges">
        {graph.edges.map((edge) => {
          const fromNode = byId.get(edge.from.node);
          const toNode = byId.get(edge.to.node);
          if (!fromNode || !toNode) return null;
          const a = anchorFor(fromNode, "out", edge.from.port);
          const b = anchorFor(toNode, "in", edge.to.port);
          return (
            <g key={edge.id} className="wfe-edge">
              <path className="wfe-edge__hit" d={bezier(a, b)} onClick={() => onRemoveEdge(edge.id)}>
                <title>click to remove</title>
              </path>
              <path className="wfe-edge__line" d={bezier(a, b)} />
            </g>
          );
        })}
      </svg>
      {graph.nodes.map((node) => (
        <NodeCard
          key={node.id}
          node={node}
          selected={node.id === selectedId}
          status={nodeStates[node.id]}
          pendingPort={pendingPort}
          onSelect={onSelect}
          onHeaderPointerDown={onHeaderPointerDown}
          onPortClick={onPortClick}
        />
      ))}
    </div>
  );
}
