// Orchestrator worker tools render with the exact same chrome as every other
// tool row (tool-item header + report-detail body, like send_message_to_parent)
// — only the worker-name resolution (tool input/result JSON) is bespoke;
// click-to-select is the shared AgentLink.

import { useUi } from "../../../state/ui.jsx";
import { defaultToolExpanded } from "../../../settings/toolExpansion.js";
import { AgentLink } from "./AgentLink.jsx";
import { DisclosureRow } from "./DisclosureRow.jsx";

const TOOLS = {
  mcp__orchestrator__spawn_worker: { verb: "Spawned", running: "Spawning", detail: (t) => t.input?.prompt ?? "" },
  mcp__orchestrator__kill_worker: { verb: "Killed", running: "Killing" },
  mcp__orchestrator__message_worker: { verb: "Messaged", running: "Messaging", detail: (t) => t.input?.text ?? "" },
  mcp__orchestrator__get_worker: { verb: "Checked", running: "Checking" },
  mcp__orchestrator__list_workers: { verb: "Listed", running: "Listing" },
  mcp__orchestrator__list_pending_permissions: { verb: "Checked", running: "Checking" },
};

export function isWorkerTool(name) {
  return Object.hasOwn(TOOLS, name);
}

function parseResultJson(tool) {
  const text = tool.result?.text ?? "";
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function workerIdentity(tool, workers) {
  const res = parseResultJson(tool);
  const fromRes = res && !Array.isArray(res) ? res : null;
  const id = tool.input?.id ?? fromRes?.id ?? null;
  const live = id ? (workers ?? []).find((w) => w.id === id) : null;
  const name = tool.input?.name ?? live?.name ?? fromRes?.name ?? id ?? "worker";
  return { id, name };
}

function failureKind(tool) {
  if (!tool.result?.isError) return null;
  const text = tool.result.text ?? "";
  return /^denied|permission mode|denied by policy/i.test(text) ? "denied" : "failed";
}

function Target({ tool, workers }) {
  if (tool.name === "mcp__orchestrator__list_workers") {
    const res = parseResultJson(tool);
    const count = Array.isArray(res) ? res.length : null;
    return <span className="ti-file">{count != null ? `workers (${count})` : "workers"}</span>;
  }
  if (tool.name === "mcp__orchestrator__list_pending_permissions") {
    return <span className="ti-file">pending permissions</span>;
  }
  const { id, name } = workerIdentity(tool, workers);
  return <AgentLink id={id} name={name} workers={workers} />;
}

export function WorkerToolCard({ tool, workers, standalone }) {
  const ui = useUi();
  const spec = TOOLS[tool.name];
  // tool.running is authoritative — computed once in messageParser from the
  // tool lifecycle (results, tool_done, turn/exit barriers).
  const running = tool.running === true;
  const failure = failureKind(tool);
  const detail = failure ? (tool.result?.text ?? "") : (spec.detail?.(tool) ?? "");
  const hasDetail = detail.trim().length > 0;

  const expandKey = "i:" + (tool.id ?? tool.ts);
  // expandedTools holds toggles against the settings-driven default (XOR)
  const expanded = hasDetail && defaultToolExpanded(tool.name, ui.settings) !== ui.expandedTools.has(expandKey);

  return (
    <div className={"tool-item" + (standalone ? " standalone" : "") + (failure ? ` ti-failed-state ti-failed-state-${failure}` : "")}>
      <DisclosureRow
        expanded={expanded}
        expandable={hasDetail}
        onToggle={() => ui.toggleToolExpanded(expandKey)}
        className={"tool-item-header" + (running ? " ti-running" : "")}
      >
        <span className={"ti-verb" + (running ? " ti-shimmer" : "")}>{running ? spec.running : spec.verb}</span>
        {" "}
        <Target tool={tool} workers={workers} />
        {failure && <span className={`ti-failed ti-failed-${failure}`}>{failure}</span>}
      </DisclosureRow>
      {expanded && (
        <div className="report-detail" style={{ marginLeft: 0 }}>
          <div className="report-detail-text">{detail}</div>
        </div>
      )}
    </div>
  );
}
