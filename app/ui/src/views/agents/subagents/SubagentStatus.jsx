import { subagentMeta } from "../../../lib/subagentRuns.js";
import { getToolView } from "../messages/toolViews.jsx";

// What a running subagent is doing right now (or did last), worded like its tool
// row. Subagents report only tool pulses, never thinking — so between tools the
// last one stays on screen instead of flickering to "Thinking…". A summary
// (lib/subagentSummary.js) names that tool as its `activity`.
export function subagentActivity(run) {
  const last = run.tools ? (run.tools.findLast((t) => t.running) ?? run.tools.at(-1)) : run.activity;
  if (!last) return "Thinking…";
  const { verb, file } = getToolView(last.name).runningLabel(last);
  return file ? `${verb} ${file}` : verb;
}

export function SubagentMeta({ run, now }) {
  const { text, tone } = subagentMeta(run, now);
  return <span className={"sa-meta sa-meta--" + tone}>{text}</span>;
}
