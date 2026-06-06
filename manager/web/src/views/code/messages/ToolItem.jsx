import { useState, useEffect } from "react";
import { useUi } from "../../../state/ui.jsx";
import { gitActions } from "../../../lib/messageParser.js";
import { defaultToolExpanded } from "../../../settings/toolExpansion.js";
import { ToolDetail } from "./ToolDetail.jsx";

const APPEAR_MS = 600;

export function ToolItem({ tool, standalone, cwd }) {
  const ui = useUi();
  const expandKey = "i:" + (tool.id ?? tool.ts);
  // expandedTools holds toggles against the settings-driven default (XOR)
  const expanded = defaultToolExpanded(tool.name, ui.settings) !== ui.expandedTools.has(expandKey);
  const isRecent = (Date.now() - tool.ts) < 5000;
  const [justAppeared, setJustAppeared] = useState(isRecent && !!tool.result);
  useEffect(() => {
    if (!justAppeared) return;
    const t = setTimeout(() => setJustAppeared(false), APPEAR_MS);
    return () => clearTimeout(t);
  }, [justAppeared]);
  const isRunning = (tool.running && !tool.done) || (!tool.done && tool.result === null) || justAppeared;
  const label = isRunning ? runningLabel(tool) : itemLabel(tool);
  const hasPath = (tool.name === "Read" || tool.name === "Edit" || tool.name === "Write") && tool.input?.file_path;
  const failure = failureKind(tool);

  const onFileClick = (e) => {
    if (!hasPath) return;
    e.stopPropagation();
    ui.openFileViewer(tool.input.file_path);
  };

  const diffStats = tool.name === "Edit" ? editStats(tool) : null;

  return (
    <div className={"tool-item" + (standalone ? " standalone" : "") + (expanded ? " expanded" : "") + (failure ? ` ti-failed-state ti-failed-state-${failure}` : "")}>
      <div className={"tool-item-header" + (isRunning ? " ti-running" : "")} onClick={() => !isRunning && ui.toggleToolExpanded(expandKey)}>
        <span className={"ti-verb" + (isRunning ? " ti-shimmer" : "")}>{label.verb}</span>
        {" "}
        <span className={"ti-file" + (hasPath ? " ti-link" : "")} onClick={onFileClick}>{label.file}</span>
        {failure && <span className={`ti-failed ti-failed-${failure}`}>{failure}</span>}
        {!failure && diffStats && (diffStats.add > 0 || diffStats.del > 0) && (
          <span className="ti-stats">
            {diffStats.add > 0 && <span className="ti-add">+{diffStats.add}</span>}
            {diffStats.add > 0 && diffStats.del > 0 && " "}
            {diffStats.del > 0 && <span className="ti-del">-{diffStats.del}</span>}
          </span>
        )}
        <svg className="ti-chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="m6 4 4 4-4 4" />
        </svg>
      </div>
      {expanded && <ToolDetail tool={tool} cwd={cwd} />}
    </div>
  );
}

function editStats(tool) {
  const oldLines = (tool.input?.old_string ?? "").split("\n");
  const newLines = (tool.input?.new_string ?? "").split("\n");
  const m = oldLines.length, n = newLines.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = oldLines[i - 1] === newLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const shared = dp[m][n];
  return { add: n - shared, del: m - shared };
}

function runningLabel(tool) {
  const name = tool.name ?? "";
  if (name === "Read") return { verb: "Reading", file: fileName(tool.input?.file_path) };
  if (name === "Bash") return { verb: "Running", file: (tool.input?.command ?? "").slice(0, 60) };
  if (name === "Edit") return { verb: "Editing", file: fileName(tool.input?.file_path) };
  if (name === "Write") return { verb: "Writing", file: fileName(tool.input?.file_path) };
  if (name === "Glob" || name === "Grep") return { verb: "Searching", file: tool.input?.pattern ?? tool.input?.query ?? "" };
  if (name === "AskUserQuestion") return { verb: "Asking", file: "user" };
  if (name === "Skill") return { verb: "Using", file: `${tool.input?.skill ?? "skill"} skill` };
  if (name === "mcp__orchestrator__notify_user") return { verb: "Notifying", file: "user" };
  return { verb: "Running", file: name };
}

function itemLabel(tool) {
  const name = tool.name ?? "";
  if (name === "Read") {
    return { verb: "Read", file: fileName(tool.input?.file_path) };
  }
  if (name === "Bash") {
    const actions = gitActions(tool);
    if (actions.length > 0) {
      const verb = actions.map((a) => a.verb).join(", ");
      const shas = actions.flatMap((a) => a.shas ?? []);
      const file = shas.length > 0 ? shas.join(", ") : actions[actions.length - 1].detail;
      return { verb, file };
    }
    const cmd = (tool.input?.command ?? "").slice(0, 60);
    return { verb: "Ran", file: cmd };
  }
  if (name === "Edit" || name === "Write") {
    return { verb: name, file: fileName(tool.input?.file_path) };
  }
  if (name === "mcp__worker__send_message_to_parent") {
    return { verb: "Sent report to", file: "orchestrator" };
  }
  if (name === "mcp__orchestrator__message_worker") {
    return { verb: "Messaged", file: tool.input?.id ?? "worker" };
  }
  if (name === "mcp__orchestrator__notify_user") {
    return { verb: "Notified", file: "user" };
  }
  if (name === "AskUserQuestion") return { verb: "Asked", file: "user" };
  if (name === "Skill") return { verb: "Used", file: `${tool.input?.skill ?? "skill"} skill` };
  return { verb: "Used", file: name };
}

function fileName(p) {
  if (!p) return "";
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

function failureKind(tool) {
  if (!tool.result?.isError) return null;
  const text = tool.result.text ?? "";
  return /^denied|permission mode|denied by policy/i.test(text) ? "denied" : "failed";
}
