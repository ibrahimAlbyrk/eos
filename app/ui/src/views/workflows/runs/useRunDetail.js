// One run's live detail: backfill the run row + per-node step rows on mount
// (GET /workflows/:id + /:id/steps), seed the per-node coloring from the steps, then
// keep it live off the shared SSE stream. step-change / run-change for THIS run fold
// instantly into node coloring via the reused runEvents reducer; they also (with
// step-output for a worker belonging to this run) debounce a step refetch so the
// step rows' output + timings stay fresh. The stream is torn down on unmount / runId
// change.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../api/client.js";
import { createReconnectingStream } from "../../../api/sse.js";
import { parseChange, reduceRunEvent, createRunState } from "../editor/runEvents.js";
import { stepsToNodeStates } from "./runsModel.js";

export function useRunDetail(runId) {
  const [run, setRun] = useState(null);
  const [steps, setSteps] = useState([]);
  const [runState, setRunState] = useState(() => createRunState(runId));
  const [loading, setLoading] = useState(true);
  const workerIds = useRef(new Set());
  const refreshTimer = useRef(null);

  const fetchRows = useCallback(async (id) => {
    const [row, rows] = await Promise.all([api.getWorkflowRun(id), api.getWorkflowRunSteps(id)]);
    const list = Array.isArray(rows) ? rows : [];
    workerIds.current = new Set(list.map((s) => s.workerId).filter(Boolean));
    return { row: row || null, list };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRunState(createRunState(runId));
    (async () => {
      const { row, list } = await fetchRows(runId);
      if (cancelled) return;
      setRun(row);
      setSteps(list);
      setRunState(createRunState(runId, { runStatus: row?.status, nodeStates: stepsToNodeStates(list) }));
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [runId, fetchRows]);

  useEffect(() => {
    if (!runId) return undefined;
    const scheduleRefresh = () => {
      if (refreshTimer.current) return;
      refreshTimer.current = setTimeout(async () => {
        refreshTimer.current = null;
        const { row, list } = await fetchRows(runId);
        setRun(row);
        setSteps(list);
      }, 300);
    };
    const stream = createReconnectingStream({
      onChange: (e) => {
        const change = parseChange(e.data);
        if (!change) return;
        const p = change.payload || {};
        if (change.reason === "workflow:run-change" || change.reason === "workflow:step-change") {
          if (p.runId !== runId) return;
          setRunState((s) => reduceRunEvent(s, change));
          scheduleRefresh();
        } else if (change.reason === "workflow:step-output" && p.workerId && workerIds.current.has(p.workerId)) {
          // step-output carries no runId/nodeId — attribute it by the worker we
          // already know belongs to this run, then pull the typed output via refetch.
          scheduleRefresh();
        }
      },
    });
    return () => {
      stream.close();
      if (refreshTimer.current) { clearTimeout(refreshTimer.current); refreshTimer.current = null; }
    };
  }, [runId, fetchRows]);

  return { run, steps, runState, loading };
}
