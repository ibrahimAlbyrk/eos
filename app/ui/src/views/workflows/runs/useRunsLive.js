// The runs LIST store: active (in-flight, cross-owner) + recent (capped history),
// backfilled by GET /workflows/runs and kept live by one shared SSE stream. A
// workflow:run-change folds instantly into the matching row's status (snappy color
// flip) and ALSO schedules a debounced reload so membership churn — a new run
// entering `active`, a settled run migrating active→recent — converges without a
// manual refresh. The stream is torn down on unmount.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../api/client.js";
import { createReconnectingStream } from "../../../api/sse.js";
import { parseChange } from "../editor/runEvents.js";
import { applyRunChangeToList, sortRunsByRecency } from "./runsModel.js";

export function useRunsLive() {
  const [state, setState] = useState({ status: "loading", active: [], recent: [], error: null });
  const reloadTimer = useRef(null);

  const load = useCallback(async () => {
    try {
      const [active, recent] = await Promise.all([
        api.listWorkflowRuns("active"),
        api.listWorkflowRuns("recent"),
      ]);
      setState({
        status: "ready",
        active: sortRunsByRecency(Array.isArray(active) ? active : []),
        recent: sortRunsByRecency(Array.isArray(recent) ? recent : []),
        error: null,
      });
    } catch (e) {
      setState((s) => ({ ...s, status: s.status === "loading" ? "error" : s.status, error: e instanceof Error ? e.message : String(e) }));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const scheduleReload = () => {
      if (reloadTimer.current) return;
      reloadTimer.current = setTimeout(() => { reloadTimer.current = null; load(); }, 400);
    };
    const stream = createReconnectingStream({
      onChange: (e) => {
        const change = parseChange(e.data);
        if (!change || change.reason !== "workflow:run-change") return;
        const p = change.payload || {};
        setState((s) => {
          const active = applyRunChangeToList(s.active, p);
          const recent = applyRunChangeToList(s.recent, p);
          return active === s.active && recent === s.recent ? s : { ...s, active, recent };
        });
        scheduleReload();
      },
    });
    return () => {
      stream.close();
      if (reloadTimer.current) { clearTimeout(reloadTimer.current); reloadTimer.current = null; }
    };
  }, [load]);

  return { ...state, reload: load };
}
