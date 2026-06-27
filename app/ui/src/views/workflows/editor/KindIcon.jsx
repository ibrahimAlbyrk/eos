// Renders a node kind's line glyph from the pure descriptor map in nodeVisuals.
// 16px, single stroke, currentColor — the card CSS sets currentColor to the
// category accent (var(--k)) so the icon reads in its kind's hue. The descriptor
// data lives in nodeVisuals (testable, DOM-free); this is only the SVG mapping.
import { kindIcon } from "./nodeVisuals.js";

function shape(el, i) {
  switch (el.t) {
    case "circle":
      return <circle key={i} cx={el.cx} cy={el.cy} r={el.r} />;
    case "line":
      return <line key={i} x1={el.x1} y1={el.y1} x2={el.x2} y2={el.y2} />;
    case "rect":
      return <rect key={i} x={el.x} y={el.y} width={el.w} height={el.h} rx={el.rx} />;
    default:
      return <path key={i} d={el.d} />;
  }
}

export function KindIcon({ kind, size = 16, className = "wf-rf-node__icon" }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {kindIcon(kind).map(shape)}
    </svg>
  );
}
