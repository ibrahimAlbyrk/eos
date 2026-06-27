// Subscribe to the daemon SSE stream for the active run and fold per-node status
// transitions into run state for live canvas highlighting. Opens a dedicated
// reconnecting stream while a runId is set; tears it down when the run clears or
// the editor unmounts.
import { useEffect, useState } from "react";
import { createReconnectingStream } from "../../../api/sse.js";
import { createRunState, parseChange, reduceRunEvent } from "./runEvents.js";

export function useWorkflowRun(runId) {
  const [runState, setRunState] = useState(() => createRunState(runId));

  useEffect(() => {
    setRunState(createRunState(runId));
    if (!runId) return undefined;
    const stream = createReconnectingStream({
      onChange: (e) => {
        const change = parseChange(e.data);
        if (change) setRunState((s) => reduceRunEvent(s, change));
      },
    });
    return () => stream.close();
  }, [runId]);

  return runState;
}
