// The SVG minimap overview for the bespoke renderer — RF's MiniMap equivalent. It
// draws every node box at scale plus a rectangle for the area currently in view, and
// click/drag inside it recenters the main viewport there (onNavigate). The flow↔mini
// transform is the pure minimapProjection, shared by the box layout, the viewport
// indicator, AND the pointer hit-test so they can never disagree.
import { useCallback, useRef } from "react";
import { minimapProjection, unionRect } from "./minimap.js";
import { nodesBounds } from "./sceneModel.js";
import { visibleFlowRect } from "./viewport.js";

const MM_W = 180;
const MM_H = 120;
const MM_PAD = 6;

export function Minimap({ scene, viewport, paneSize, onNavigate }) {
  const ref = useRef(null);

  const visRect = paneSize.width > 0 && paneSize.height > 0 ? visibleFlowRect(viewport, paneSize) : null;
  // Cover both the nodes and the visible area so the indicator stays in frame even
  // after panning the nodes off to one side.
  const bounds = unionRect(nodesBounds(scene.nodes), visRect) || { x: 0, y: 0, w: 1, h: 1 };
  const proj = minimapProjection(bounds, { width: MM_W, height: MM_H }, MM_PAD);

  const navigateTo = useCallback((clientX, clientY) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    onNavigate(proj.fromMini({ x: clientX - r.left, y: clientY - r.top }));
  }, [onNavigate, proj]);

  const onPointerDown = useCallback((e) => {
    e.stopPropagation();
    ref.current?.setPointerCapture?.(e.pointerId);
    navigateTo(e.clientX, e.clientY);
  }, [navigateTo]);
  const onPointerMove = useCallback((e) => {
    if (e.buttons === 0) return; // drag only
    navigateTo(e.clientX, e.clientY);
  }, [navigateTo]);
  const onPointerUp = useCallback((e) => {
    try { ref.current?.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
  }, []);

  const vTL = visRect ? proj.toMini({ x: visRect.x, y: visRect.y }) : null;
  const vBR = visRect ? proj.toMini({ x: visRect.x + visRect.w, y: visRect.y + visRect.h }) : null;

  return (
    <svg
      ref={ref}
      className="wf-svg-minimap"
      width={MM_W}
      height={MM_H}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {scene.nodes.map((n) => {
        const tl = proj.toMini({ x: n.box.x, y: n.box.y });
        return (
          <rect
            key={n.id}
            className={"wf-svg-minimap__node" + (n.status ? " wf-svg-minimap__node--" + n.status : "")}
            x={tl.x}
            y={tl.y}
            width={n.box.w * proj.scale}
            height={n.box.h * proj.scale}
            rx="1.5"
          />
        );
      })}
      {vTL && (
        <rect className="wf-svg-minimap__viewport" x={vTL.x} y={vTL.y} width={vBR.x - vTL.x} height={vBR.y - vTL.y} />
      )}
    </svg>
  );
}
