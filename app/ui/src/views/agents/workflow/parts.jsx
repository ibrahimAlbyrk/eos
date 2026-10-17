// Pieces the Workflow run card and its side-panel tab share.

import { useEffect, useRef, useState } from "react";
import { notify } from "../../../lib/notify.js";
import { fmtElapsedShort, fmtTokens } from "../../../lib/format.js";
import { stopWorkflowRun } from "../../../state/workflowRunsStore.js";
import { SubagentGlyph } from "../subagents/SubagentGlyph.jsx";

export const WorkflowIcon = ({ size = 16 }) => (
  <svg className="wr-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
    <circle cx="3.5" cy="8" r="2" /><circle cx="12.5" cy="3.5" r="2" /><circle cx="12.5" cy="12.5" r="2" />
    <path d="M5.5 8H8M8 3.5v9M8 3.5h2.5M8 12.5h2.5" />
  </svg>
);

const STATUS_LABEL = { starting: "Starting", queued: "Queued", running: "Running", completed: "Done", failed: "Failed", stopped: "Stopped" };

export function StatusChip({ status }) {
  return <span className={`wr-chip wr-chip--${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

// A queued agent has no identity on screen yet — just its place in line.
export function AgentGlyph({ agent, size = 14 }) {
  if (agent.state === "queued") {
    return (
      <svg className="wr-queued" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2.2 2.2" aria-hidden="true">
        <circle cx="8" cy="8" r="6" />
      </svg>
    );
  }
  return <SubagentGlyph identity={agent.identity} status={agent.glyphStatus} size={size} />;
}

export const fmtTime = (ms) => (ms == null ? "" : fmtElapsedShort(ms));

export function totalsLine(t) {
  return [
    `${t.agents} agent${t.agents === 1 ? "" : "s"}`,
    t.running ? `${t.running} running` : null,
    t.queued ? `${t.queued} queued` : null,
    t.failed ? `${t.failed} failed` : null,
    t.stopped ? `${t.stopped} stopped` : null,
    t.toolUses ? `${t.toolUses} tool uses` : null,
    t.tokens ? `${fmtTokens(t.tokens)} tokens` : null,
  ].filter(Boolean).join(" · ");
}

// Stopping ends every agent the run has going, so the first click only arms it.
export function StopButton({ workerId, callId }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const click = async (e) => {
    e.stopPropagation();
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), 3000);
      return;
    }
    clearTimeout(timer.current);
    setBusy(true);
    try { await stopWorkflowRun(workerId, callId); }
    catch (err) { notify.error(`Couldn't stop the workflow: ${err instanceof Error ? err.message : String(err)}`); }
    finally { setBusy(false); setArmed(false); }
  };
  return (
    <button type="button" className={"wr-btn" + (armed ? " is-armed" : "")} onClick={click} disabled={busy} aria-label={armed ? "Confirm stopping the workflow" : "Stop workflow"}>
      <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor" /></svg>
      {armed ? "Stop run?" : "Stop"}
    </button>
  );
}
