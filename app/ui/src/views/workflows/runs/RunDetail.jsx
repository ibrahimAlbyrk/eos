// One run's read-only detail. Header: definition name (or "inline"), run id, live
// status chip, elapsed, and — for an active run — a Stop control (confirm-gated, the
// one run-write op in the UI). Body: a v2-graph run renders the read-only canvas
// with live node coloring plus the per-node step side-list; an inline / v1-tree run
// (no graph to draw) falls back to the step list alone. Live node coloring + run
// status come from useRunDetail (SSE-folded); the canvas is lazy so the @xyflow
// chunk stays out of the main bundle.
import { lazy, Suspense, useEffect, useState } from "react";
import { api } from "../../../api/client.js";
import { useRunDetail } from "./useRunDetail.js";
import { StepList } from "./StepList.jsx";
import {
  findRunDefinition, resolveRunView, runDurationMs, formatDuration,
  isActiveRunStatus, canStopRun,
} from "./runsModel.js";

const RunCanvas = lazy(() => import("./RunCanvas.jsx").then((m) => ({ default: m.RunCanvas })));

// Tick once a second while `enabled` so an active run's elapsed counts up; frozen
// (a single read) otherwise. Browser clock — only the workflow SCRIPT env bans
// Date.now, this is app code.
function useNow(enabled) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

function StopControl({ run, onFlash }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const doStop = async () => {
    setBusy(true);
    const r = await api.stopWorkflowRun(run.id);
    setBusy(false);
    setConfirming(false);
    if (r.ok) onFlash("ok", `stopping ${run.id}`);
    else onFlash("err", `stop failed: ${r.body?.error || r.status}`);
  };
  if (!confirming) {
    return <button type="button" className="wfe-btn wfe-btn--danger" onClick={() => setConfirming(true)}>Stop</button>;
  }
  return (
    <span className="wf-run-detail__confirm">
      <span className="wf-run-detail__confirm-q">Stop this run?</span>
      <button type="button" className="wfe-btn wfe-btn--danger" disabled={busy} onClick={doStop}>Yes, stop</button>
      <button type="button" className="wfe-btn" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
    </span>
  );
}

export function RunDetail({ runId, records }) {
  const { run, steps, runState, loading } = useRunDetail(runId);
  const [notice, setNotice] = useState(null);
  const flash = (type, text) => setNotice({ type, text });

  const status = runState.runStatus || run?.status || "pending";
  const isActive = isActiveRunStatus(status);
  const now = useNow(isActive);
  const effRun = run ? { ...run, status } : null;

  const record = findRunDefinition(records, run);
  const view = resolveRunView(run, record);

  if (loading && !run) return <div className="wf-run-detail__state">Loading run…</div>;
  if (!run) return <div className="wf-run-detail__state">Run not found — it may have been pruned.</div>;

  return (
    <div className="wf-run-detail">
      <div className="wf-run-detail__head">
        <div className="wf-run-detail__title">
          <span className="wf-run-detail__name">{run.definitionName || "inline"}</span>
          <span className="wf-run-detail__id">{run.id}</span>
        </div>
        <span className={"wf-status wf-status-" + status}>{status}</span>
        <span className="wf-run-detail__elapsed">{formatDuration(runDurationMs(effRun, now))}</span>
        <div className="wf-run-detail__spacer" />
        {canStopRun(effRun) && <StopControl run={run} onFlash={flash} />}
        {notice && <span className={"wfe-notice wfe-notice--" + notice.type}>{notice.text}</span>}
      </div>

      {view === "graph" ? (
        <div className="wf-run-detail__body wf-run-detail__body--graph">
          <Suspense fallback={<div className="wf-rf-canvas wf-rf-canvas--loading">Loading canvas…</div>}>
            <RunCanvas record={record} nodeStates={runState.nodeStates} />
          </Suspense>
          <div className="wf-run-detail__side">
            <div className="wf-run-detail__side-title">Steps</div>
            <StepList steps={steps} nodeStates={runState.nodeStates} nowMs={now} />
          </div>
        </div>
      ) : (
        <div className="wf-run-detail__body wf-run-detail__body--steps">
          <StepList steps={steps} nodeStates={runState.nodeStates} nowMs={now} />
        </div>
      )}
    </div>
  );
}
