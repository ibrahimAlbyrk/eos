// Workflow surfaces in the chat — the `mcp__orchestrator__workflow` tool call +
// result card, and the run-completion report that arrives as a worker_report
// envelope (workerName "workflow"). Both reuse the worker-definition card chrome
// (.wd-card / .wd-sec) and the generic section header (.gd-section) so a workflow
// reads like every other tool; the only new chrome is the run-status chip.
//
// Header labels + the registry entry live in ./toolViews.jsx (Open/Closed); this
// file owns the bodies, the status chip, and the result parsing.

import { useState } from "react";
import { DisclosureRow } from "./DisclosureRow.jsx";
import { FailureBanner, CopyButton } from "./ToolDetail.jsx";

// Run/step lifecycle statuses (contracts WORKFLOW_RUN_STATUSES) mapped to the
// same semantic colors used elsewhere: passed→ok, failed→err, running→accent,
// stopped→warn, pending→neutral.
const STATUS_CLASS = {
  passed: "wf-status-passed",
  failed: "wf-status-failed",
  running: "wf-status-running",
  pending: "wf-status-pending",
  stopped: "wf-status-stopped",
};

export function WorkflowStatusChip({ status }) {
  if (!status) return null;
  return <span className={"wf-status " + (STATUS_CLASS[status] ?? "wf-status-pending")}>{status}</span>;
}

// Result JSON of the workflow tool call, or null while running / on a non-JSON
// (error) result. Shapes per mode: run-* → {runId,status,message}, create →
// {name,message}, status → {runId,status,output?}, stop → {runId,status,message}.
function wfResult(tool) {
  const text = tool.result?.text ?? "";
  if (!text.trim().startsWith("{")) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function specName(spec) {
  return spec && typeof spec === "object" ? spec.name ?? null : null;
}

// The name shown after the header verb: the definition for create/run-stored,
// else the run id being acted on.
function wfName(tool, res) {
  const i = tool.input ?? {};
  switch (i.mode) {
    case "create": return res?.name ?? specName(i.spec) ?? "";
    case "run-stored": return i.from ?? res?.runId ?? "";
    case "run-inline": return specName(i.spec) ?? res?.runId ?? "";
    default: return i.runId ?? res?.runId ?? "";
  }
}

const MODE_VERB = {
  "run-stored": ["Ran workflow", "Running workflow"],
  "run-inline": ["Ran workflow", "Running workflow"],
  "create": ["Saved workflow", "Saving workflow"],
  "status": ["Checked workflow", "Checking workflow"],
  "stop": ["Stopped workflow", "Stopping workflow"],
};

export function workflowLabel(tool) {
  const verb = (MODE_VERB[tool.input?.mode] ?? ["Used workflow"])[0];
  return { verb, file: wfName(tool, wfResult(tool)) };
}

export function workflowRunningLabel(tool) {
  const verb = (MODE_VERB[tool.input?.mode] ?? [null, "Using workflow"])[1];
  return { verb, file: wfName(tool, null) };
}

// At-a-glance run status pill at the right of the tool header — visible without
// expanding, the same affordance as the spawn "loop" badge.
export function workflowHeaderBadge(tool) {
  const status = wfResult(tool)?.status;
  return status ? <WorkflowStatusChip status={status} /> : null;
}

// Pretty-print a result for legible display: a JSON object/array is indented two
// spaces; a string that happens to be JSON is reparsed; anything else passes
// through. This is the core "read cleanly, not a raw dump" transform.
function prettyValue(value) {
  if (value == null) return "";
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return "";
    try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return t; }
  }
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function WorkflowToolDetail({ tool }) {
  const res = wfResult(tool);
  const isError = tool.result?.isError === true;
  const running = tool.running === true;
  const id = res?.runId ?? res?.name ?? tool.input?.runId ?? tool.input?.from ?? null;
  const message = res?.message ?? null;
  const output = res?.output;
  const hasOutput = output !== undefined && output !== null && output !== "";

  if (!res && !isError && !running) return null;

  return (
    <div className="tool-detail wd-card wf-card">
      {isError && <FailureBanner tool={tool} />}
      {!isError && (id || res?.status) && (
        <div className="wd-sec wf-head">
          {id && <span className="wf-id">{id}</span>}
          <WorkflowStatusChip status={res?.status} />
        </div>
      )}
      {!isError && !res && running && (
        <div className="wd-sec"><div className="wd-desc wf-running">Running…</div></div>
      )}
      {message && (
        <div className="wd-sec"><div className="wd-desc">{message}</div></div>
      )}
      {hasOutput && (
        <div className="wd-sec">
          <div className="gd-section"><span>Output</span><CopyButton text={prettyValue(output)} title="Copy output" /></div>
          <pre className="wf-result">{prettyValue(output)}</pre>
        </div>
      )}
    </div>
  );
}

// Completion text: "[workflow <runId>] completed (status: <passed|failed>):\n<result JSON>".
function parseCompletion(text, runIdFallback) {
  const m = /^\[workflow (.+?)\]\s+completed\s+\(status:\s*(\w+)\)\s*:?\s*\n?/i.exec(text ?? "");
  return {
    runId: m?.[1] ?? runIdFallback ?? null,
    status: m?.[2] ?? null,
    body: m ? (text ?? "").slice(m[0].length) : (text ?? ""),
  };
}

// The run-completion report (worker_report envelope, workerName "workflow"). The
// status chip + run id sit in the always-visible header; the full result renders
// pretty-printed in the collapsible body — same collapse default as MessageReport.
export function WorkflowReport({ text, runId }) {
  const [open, setOpen] = useState(false);
  const { runId: parsedId, status, body } = parseCompletion(text, runId);
  const pretty = prettyValue(body);

  return (
    <div className="tool-item standalone">
      <DisclosureRow expanded={open} onToggle={() => setOpen((o) => !o)} className="tool-item-header">
        <span className="ti-verb">Workflow completed</span>{" "}
        {parsedId && <span className="wf-id">{parsedId}</span>}
        <WorkflowStatusChip status={status} />
      </DisclosureRow>
      {open && pretty && (
        <div className="tool-detail wd-card wf-card">
          <div className="wd-sec">
            <div className="gd-section"><span>Result</span><CopyButton text={pretty} title="Copy result" /></div>
            <pre className="wf-result">{pretty}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
