// React context carrying the in-flight connection so every WfNode can light its
// handles receptive/reject during a drag WITHOUT the node array being rebuilt
// per frame. FlowCanvas provides `receptivityFor`, a closure over the live graph
// + drag source (it recomputes only when the drag starts/ends, i.e. twice per
// connection, not on pointermove). Lives in its own module so WfNode and
// FlowCanvas share it without an import cycle.
import { createContext, useContext } from "react";

export const WfConnectionContext = createContext(null);

export function useWfConnection() {
  return useContext(WfConnectionContext);
}
