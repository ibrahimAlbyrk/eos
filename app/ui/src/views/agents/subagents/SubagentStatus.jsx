import { subagentMeta } from "../../../lib/subagentRuns.js";
import { getToolView } from "../messages/toolViews.jsx";

// What a running subagent is doing right now, worded like its tool row.
export function subagentActivity(run) {
  const tools = run.tools ?? [];
  const live = tools.findLast((t) => t.running);
  if (live) {
    const { verb, file } = getToolView(live.name).runningLabel(live);
    return file ? `${verb} ${file}` : verb;
  }
  return tools.length ? "Thinking…" : "Starting…";
}

export function SubagentMeta({ run, now }) {
  const { text, tone } = subagentMeta(run, now);
  return <span className={"sa-meta sa-meta--" + tone}>{text}</span>;
}
