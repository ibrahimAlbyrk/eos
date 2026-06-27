// React Flow custom edge — a bezier wire whose tangents scale with the handle gap
// (RF's getBezierPath). The stroke color follows the SOURCE port's data type
// (`data.type` → a CSS data-type rule that mixes the type hue toward the neutral
// wire color), so a wire and its endpoints agree. Selecting it + pressing Delete
// removes it (RF emits an edge 'remove' change → graphModel.removeEdge).
//
// During a live run, an edge on the active frontier (data.flow) gets a second
// traveling-dash path on top — the "alive" cue, scoped to running edges so it
// stops when the run is terminal.
import { BaseEdge, getBezierPath } from "@xyflow/react";

export function WfEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data }) {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const type = data?.type || "any";
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={"wf-rf-edge" + (selected ? " wf-rf-edge--selected" : "")}
        data-type={type}
      />
      {data?.flow && <path className="wf-rf-edge__flow" d={path} fill="none" />}
    </>
  );
}
