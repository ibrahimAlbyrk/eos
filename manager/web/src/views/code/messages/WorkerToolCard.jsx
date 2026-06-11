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
  mcp__orchestrator__kill_worker: { verb: "Killed", running: "Killing", detail: killWorkerDetail },
  mcp__orchestrator__message_worker: { verb: "Messaged", running: "Messaging", detail: (t) => t.input?.text ?? "" },
  mcp__orchestrator__get_worker: { verb: "Checked", running: "Checking", detail: getWorkerDetail },
  mcp__orchestrator__list_workers: { verb: "Listed", running: "Listing", detail: listWorkersDetail },
  mcp__orchestrator__list_pending_permissions: { verb: "Checked", running: "Checking", detail: pendingPermissionsDetail },
};

export function isWorkerTool(name) {
  return Object.hasOwn(TOOLS, name);
}

// The expanded body text for a worker tool — error text when the call failed,
// otherwise a readable summary of the tool's result JSON. Same plain-text
// design as spawn/message (rendered in the shared report-detail block).
export function workerToolDetailText(tool, workers) {
  const spec = TOOLS[tool.name];
  if (!spec) return "";
  if (tool.result?.isError) return tool.result?.text ?? "";
  return spec.detail?.(tool, workers) ?? "";
}

function clip(s, n = 140) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

const joinDot = (parts) => parts.filter(Boolean).join(" · ");

function nameOf(id, workers) {
  const live = id ? (workers ?? []).find((w) => w.id === id) : null;
  return live?.name ?? id ?? "worker";
}

function listWorkersDetail(tool, workers) {
  const res = parseResultJson(tool);
  if (!Array.isArray(res)) return "";
  if (res.length === 0) return "No workers.";
  return res
    .map((w) => {
      const head = joinDot([nameOf(w.id, workers), w.state]);
      const prompt = clip(w.prompt);
      return prompt ? `${head}\n${prompt}` : head;
    })
    .join("\n\n");
}

function getWorkerDetail(tool) {
  const res = parseResultJson(tool);
  const w = res && !Array.isArray(res) ? res.worker : null;
  if (!w) return "";
  const meta = joinDot([
    typeof w.cost_usd === "number" ? "$" + w.cost_usd.toFixed(4) : null,
    Array.isArray(res.events) ? `${res.events.length} events` : null,
  ]);
  return [joinDot([w.state, w.branch]), meta, clip(w.prompt)].filter(Boolean).join("\n");
}

function killWorkerDetail(tool) {
  const res = parseResultJson(tool);
  if (!res || Array.isArray(res)) return "";
  return joinDot([res.state, res.branch]);
}

function pendingPermissionsDetail(tool, workers) {
  const res = parseResultJson(tool);
  if (!Array.isArray(res)) return "";
  if (res.length === 0) return "No pending permissions.";
  return res
    .map((p) => {
      const head = joinDot([nameOf(p.worker_id, workers), p.tool]);
      const input = pendingInputSummary(p.input);
      return input ? `${head}\n${input}` : head;
    })
    .join("\n\n");
}

function pendingInputSummary(input) {
  if (input == null) return "";
  if (typeof input === "string") return clip(input);
  const pick = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? null;
  if (pick) return clip(pick);
  try { return clip(JSON.stringify(input)); } catch { return ""; }
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
  const detail = workerToolDetailText(tool, workers);
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
