// One graph node on the canvas: a draggable card with typed input handles on the
// left and output handles on the right. Port rows use the shared geometry
// constants (inline heights) so SVG edges drawn by Canvas land on the handles.
// Live run status drives the card's highlight class.
import { NODE_W, HEADER_H, PORT_H } from "./geometry.js";

function isPending(pendingPort, nodeId, portName) {
  return Boolean(pendingPort && pendingPort.node === nodeId && pendingPort.port === portName);
}

export function NodeCard({ node, selected, status, pendingPort, onSelect, onHeaderPointerDown, onPortClick }) {
  const rows = Math.max(node.inputs?.length || 0, node.outputs?.length || 0, 1);
  return (
    <div
      className={
        "wfe-node" +
        (selected ? " wfe-node--selected" : "") +
        (status ? " wfe-node--" + status : "")
      }
      style={{ left: node.ui.x, top: node.ui.y, width: NODE_W }}
      onPointerDown={(e) => { e.stopPropagation(); onSelect(node.id); }}
    >
      <div
        className="wfe-node__head"
        style={{ height: HEADER_H }}
        onPointerDown={(e) => onHeaderPointerDown(e, node.id)}
      >
        <span className="wfe-node__label">{node.label || node.kind}</span>
        <span className="wfe-node__kind">{node.kind}</span>
        {status && <span className={"wfe-node__status wf-status-" + status}>{status}</span>}
      </div>
      <div className="wfe-node__ports" style={{ minHeight: rows * PORT_H }}>
        <div className="wfe-node__col">
          {(node.inputs || []).map((p) => (
            <button
              type="button"
              key={p.name}
              className="wfe-port wfe-port--in"
              style={{ height: PORT_H }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onPortClick(node.id, "in", p.name); }}
              title={`input "${p.name}" (${p.type})`}
            >
              <span className="wfe-handle" data-type={p.type} />
              <span className="wfe-port__name">{p.name}<i className="wfe-port__type">{p.type}</i></span>
            </button>
          ))}
        </div>
        <div className="wfe-node__col wfe-node__col--out">
          {(node.outputs || []).map((p) => (
            <button
              type="button"
              key={p.name}
              className={"wfe-port wfe-port--out" + (isPending(pendingPort, node.id, p.name) ? " wfe-port--pending" : "")}
              style={{ height: PORT_H }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onPortClick(node.id, "out", p.name); }}
              title={`output "${p.name}" (${p.type}) — click, then click a target input`}
            >
              <span className="wfe-port__name"><i className="wfe-port__type">{p.type}</i>{p.name}</span>
              <span className="wfe-handle" data-type={p.type} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
