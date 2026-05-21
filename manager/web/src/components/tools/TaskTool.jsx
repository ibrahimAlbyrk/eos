import { memo, useMemo } from "react";
import { renderMarkdown } from "../../lib/markdown.js";
import { ToolShell } from "./ToolShell.jsx";
import { resultStatus } from "./shared.js";

// "Task" spawns a subagent through Claude's built-in Agent tool. The
// subagent_type is the meaningful identity here; we promote it into the
// title and color the deputize badge accordingly.
const SUBAGENT_TINT = {
  "claude": "neutral",
  "claude-code-guide": "saffron",
  "Explore": "sage",
  "general-purpose": "clay",
  "meta-agent": "plum",
  "Plan": "saffron",
  "statusline-setup": "neutral",
};

export const TaskTool = memo(function TaskTool({ tool, result, family }) {
  const description = tool.input?.description || "";
  const prompt = tool.input?.prompt || "";
  const subagent = tool.input?.subagent_type || "agent";
  const tint = SUBAGENT_TINT[subagent] || "plum";
  const body = (result?.body || "").trim();
  const html = useMemo(() => renderMarkdown(body), [body]);
  const status = resultStatus(result);

  return (
    <ToolShell
      family={family}
      icon="agentSpawn"
      title={
        <span className="vb-tool__name">
          <span className="vb-tool__verb">Task</span>
          <span className="vb-tool__arr">→</span>
          <span className={`vb-task__sub vb-task__sub--${tint}`}>{subagent}</span>
        </span>
      }
      subtitle={description && (
        <span className="vb-task__desc">{description}</span>
      )}
      status={status}
      defaultOpen={false}
      body={
        <div className="vb-toolbody vb-toolbody--task">
          {prompt && (
            <div className="vb-task__sect">
              <div className="vb-task__sect-h">briefing</div>
              <blockquote className="vb-task__brief">{prompt}</blockquote>
            </div>
          )}
          {body && (
            <div className="vb-task__sect">
              <div className="vb-task__sect-h">report</div>
              <div className="vb-task__resp vb-md" dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          )}
        </div>
      }
    />
  );
});
