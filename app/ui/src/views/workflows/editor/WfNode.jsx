// React Flow custom node — the replacement for NodeCard. Ports are RF <Handle>
// elements (pointer-drag grab handles), not <button onClick> click targets: this
// is what makes press-drag-to-connect possible. Inputs are "target" handles on
// the left edge, outputs are "source" handles on the right — RF normalizes a
// connection by handle TYPE, so dragging either direction stores output→input.
//
// During a live connection drag, each handle reads the shared WfConnection
// context and lights "receptive" (a compatible drop target) or "reject"
// (incompatible) — the same canConnect rule that gates the drop, surfaced ahead
// of it. Memoized so a status change on one node doesn't re-render its peers.
//
// Kind identity (category accent rail + per-kind icon) and run-state classes come
// from the pure nodeVisuals map; the card body stays neutral so the rail + run
// coloring read cleanly.
import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { useWfConnection } from "./wfConnection.js";
import { nodeCardClass } from "./nodeVisuals.js";
import { KindIcon } from "./KindIcon.jsx";

// Must match the row metrics in styles.css (.wf-rf-node*) so a handle sits on the
// vertical center of its labeled port row.
const HEADER_H = 30;
const ROW_H = 22;
const ROW_PAD = 6;

function handleTop(index) {
  return HEADER_H + ROW_PAD + index * ROW_H + ROW_H / 2;
}

function PortHandle({ nodeId, port, index, side, receptivityFor }) {
  const recv = receptivityFor ? receptivityFor(nodeId, port.name, side) : null;
  const cls =
    "wf-rf-handle" +
    (recv === "receptive" ? " wf-rf-handle--receptive" : "") +
    (recv === "reject" ? " wf-rf-handle--reject" : "");
  return (
    <Handle
      id={port.name}
      type={side === "in" ? "target" : "source"}
      position={side === "in" ? Position.Left : Position.Right}
      className={cls}
      data-type={port.type}
      style={{ top: handleTop(index) }}
      title={`${side === "in" ? "input" : "output"} "${port.name}" (${port.type})`}
    />
  );
}

function WfNodeImpl({ id, data, selected }) {
  const conn = useWfConnection();
  const receptivityFor = conn?.receptivityFor;
  const inputs = data.inputs || [];
  const outputs = data.outputs || [];
  const rows = Math.max(inputs.length, outputs.length, 1);
  const status = data.status;

  return (
    <div
      className={nodeCardClass(data.kind, { selected, status })}
      data-kind={data.kind}
      style={{ minHeight: HEADER_H + ROW_PAD * 2 + rows * ROW_H }}
    >
      <div className="wf-rf-node__head" style={{ height: HEADER_H }}>
        <KindIcon kind={data.kind} />
        <span className="wf-rf-node__label">{data.label || data.kind}</span>
        <span className="wf-rf-node__kind">{data.kind}</span>
        {status && <span className={"wf-rf-node__status wf-status-" + status}>{status}</span>}
      </div>

      <div className="wf-rf-node__ports">
        <div className="wf-rf-node__col wf-rf-node__col--in">
          {inputs.map((p) => (
            <div className="wf-rf-port" key={"in-" + p.name} style={{ height: ROW_H }}>
              <span className="wf-rf-port__name">{p.name}<i className="wf-rf-port__type">{p.type}</i></span>
            </div>
          ))}
        </div>
        <div className="wf-rf-node__col wf-rf-node__col--out">
          {outputs.map((p) => (
            <div className="wf-rf-port wf-rf-port--out" key={"out-" + p.name} style={{ height: ROW_H }}>
              <span className="wf-rf-port__name"><i className="wf-rf-port__type">{p.type}</i>{p.name}</span>
            </div>
          ))}
        </div>
      </div>

      {inputs.map((p, i) => (
        <PortHandle key={"h-in-" + p.name} nodeId={id} port={p} index={i} side="in" receptivityFor={receptivityFor} />
      ))}
      {outputs.map((p, i) => (
        <PortHandle key={"h-out-" + p.name} nodeId={id} port={p} index={i} side="out" receptivityFor={receptivityFor} />
      ))}
    </div>
  );
}

export const WfNode = memo(WfNodeImpl);
