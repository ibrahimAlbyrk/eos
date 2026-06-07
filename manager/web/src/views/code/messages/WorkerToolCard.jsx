import { useUi } from "../../../state/ui.jsx";
import { modelName } from "../../../lib/models.js";
import { statusFromState } from "../../../lib/format.js";
import { defaultToolExpanded } from "../../../settings/toolExpansion.js";

const LIFECYCLE = {
  mcp__orchestrator__spawn_worker: { verb: "Spawned", running: "Spawning" },
  mcp__orchestrator__kill_worker: { verb: "Killed", running: "Killing" },
  mcp__orchestrator__message_worker: { verb: "Messaged", running: "Messaging" },
};

const QUIET = {
  mcp__orchestrator__get_worker: { verb: "Checked", running: "Checking" },
  mcp__orchestrator__list_workers: { verb: "Listed", running: "Listing" },
  mcp__orchestrator__list_pending_permissions: { verb: "Checked", running: "Checking" },
};

export function isWorkerTool(name) {
  return Object.hasOwn(LIFECYCLE, name) || Object.hasOwn(QUIET, name);
}

export function WorkerToolCard({ tool, workers }) {
  if (Object.hasOwn(QUIET, tool.name)) return <QuietLine tool={tool} workers={workers} />;
  return <LifecycleCard tool={tool} workers={workers} />;
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
  return { id, live, name };
}

function isRunning(tool) {
  // tool.running is authoritative — computed once in messageParser from the
  // tool lifecycle (results, tool_done, turn/exit barriers).
  return tool.running === true;
}

function failureKind(tool) {
  if (!tool.result?.isError) return null;
  const text = tool.result.text ?? "";
  return /^denied|permission mode|denied by policy/i.test(text) ? "denied" : "failed";
}

function WorkerName({ name, live, ui }) {
  if (!live) return <span className="wt-name">{name}</span>;
  return (
    <span
      className="wt-name wt-link"
      onClick={(e) => { e.stopPropagation(); ui.setSelectedId(live.id); }}
    >{name}</span>
  );
}

function LifecycleCard({ tool, workers }) {
  const ui = useUi();
  const spec = LIFECYCLE[tool.name];
  const { live, name } = workerIdentity(tool, workers);
  const running = isRunning(tool);
  const failure = failureKind(tool);

  const detail = failure
    ? (tool.result?.text ?? "")
    : tool.name === "mcp__orchestrator__spawn_worker"
      ? (tool.input?.prompt ?? "")
      : tool.name === "mcp__orchestrator__message_worker"
        ? (tool.input?.text ?? "")
        : "";
  const hasDetail = detail.trim().length > 0;

  const expandKey = "i:" + (tool.id ?? tool.ts);
  // expandedTools holds toggles against the settings-driven default (XOR)
  const expanded = hasDetail && defaultToolExpanded(tool.name, ui.settings) !== ui.expandedTools.has(expandKey);
  const model = tool.name === "mcp__orchestrator__spawn_worker"
    ? modelName(tool.input?.model ?? "opus")
    : null;

  return (
    <div className={"wt-card" + (expanded ? " expanded" : "") + (failure ? " failed" : "")}>
      <div
        className={"wt-head" + (hasDetail ? " clickable" : "")}
        onClick={() => hasDetail && ui.toggleToolExpanded(expandKey)}
      >
        <Indicator tool={tool} live={live} running={running} />
        <span className={"wt-verb" + (running ? " ti-shimmer" : "")}>{running ? spec.running : spec.verb}</span>
        <WorkerName name={name} live={live} ui={ui} />
        {model && <span className="wt-model">{model}</span>}
        {failure && <span className={`ti-failed ti-failed-${failure}`}>{failure}</span>}
        <span className="wt-spacer" />
        {hasDetail && (
          <svg className="wt-chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="m6 4 4 4-4 4" />
          </svg>
        )}
      </div>
      {expanded && <div className={"wt-detail" + (failure ? " error" : "")}>{detail}</div>}
    </div>
  );
}

function Indicator({ tool, live, running }) {
  if (tool.name === "mcp__orchestrator__kill_worker") {
    return (
      <svg className="wt-icon kill" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    );
  }
  if (tool.name === "mcp__orchestrator__message_worker") {
    return (
      <svg className="wt-icon message" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 8h10M9 4l4 4-4 4" />
      </svg>
    );
  }
  // spawn — live status dot, same language as the sidebar tree
  const dot = live ? statusFromState(live.state).dot : running ? "think" : "wait";
  return <span className={`wt-dot ${dot}`} />;
}

function QuietLine({ tool, workers }) {
  const ui = useUi();
  const spec = QUIET[tool.name];
  const running = isRunning(tool);

  let target;
  if (tool.name === "mcp__orchestrator__list_workers") {
    const res = parseResultJson(tool);
    const count = Array.isArray(res) ? res.length : null;
    target = <span className="wt-name">{count != null ? `workers (${count})` : "workers"}</span>;
  } else if (tool.name === "mcp__orchestrator__list_pending_permissions") {
    target = <span className="wt-name">pending permissions</span>;
  } else {
    const { live, name } = workerIdentity(tool, workers);
    target = <WorkerName name={name} live={live} ui={ui} />;
  }

  return (
    <div className="wt-line">
      <span className="wt-line-dot" />
      <span className={"wt-verb" + (running ? " ti-shimmer" : "")}>{running ? spec.running : spec.verb}</span>
      {target}
    </div>
  );
}
