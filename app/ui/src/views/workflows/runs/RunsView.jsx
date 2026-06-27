// The Runs view: read-only observation of live + past workflow runs. Left rail is
// the live runs list (active + recent, useRunsLive); the right pane is the selected
// run's detail (read-only canvas with live node coloring, or the step-list fallback,
// + a Stop control for active runs). Definition records are fetched once to resolve
// each run's graph for the canvas. Mounted only while the Runs sub-tab is active, so
// its SSE streams open on entry and tear down on leave.
import { useEffect, useRef, useState } from "react";
import { api } from "../../../api/client.js";
import { useRunsLive } from "./useRunsLive.js";
import { RunsList } from "./RunsList.jsx";
import { RunDetail } from "./RunDetail.jsx";

export function RunsView() {
  const { status, active, recent, error, reload } = useRunsLive();
  const [records, setRecords] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const autoSelected = useRef(false);

  useEffect(() => {
    api.listWorkflowDefinitions().then((r) => setRecords(Array.isArray(r) ? r : [])).catch(() => setRecords([]));
  }, []);

  // Tick the list's elapsed clock only while runs are in flight.
  useEffect(() => {
    if (active.length === 0) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active.length]);

  // Open the most-recent active run once on first load, so the pane isn't empty when
  // something is running. Never overrides a manual selection.
  useEffect(() => {
    if (autoSelected.current || selectedId) return;
    if (active.length > 0) { setSelectedId(active[0].id); autoSelected.current = true; }
  }, [active, selectedId]);

  return (
    <div className="wf-runs">
      <div className="wf-runs__rail">
        <div className="wf-runs__bar">
          <div className="wf-runs__title">Runs</div>
          <button type="button" className="wfe-btn" onClick={reload} disabled={status === "loading"}>Refresh</button>
        </div>
        {status === "error" && (
          <div className="wf-runs__state wf-runs__state--err">
            Couldn’t load runs{error ? `: ${error}` : ""}.
            <button type="button" className="wfe-btn" onClick={reload}>Retry</button>
          </div>
        )}
        {status !== "error" && (
          <RunsList active={active} recent={recent} selectedId={selectedId} onSelect={setSelectedId} nowMs={now} />
        )}
      </div>
      <div className="wf-runs__detail">
        {selectedId
          ? <RunDetail key={selectedId} runId={selectedId} records={records} />
          : <div className="wf-runs__empty">Select a run to observe it.</div>}
      </div>
    </div>
  );
}
