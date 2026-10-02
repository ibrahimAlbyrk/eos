import { subagentMeta } from "../../../lib/subagentRuns.js";
import { getToolView } from "../messages/toolViews.jsx";

// What a running subagent is doing right now (or did last), worded like its tool
// row. Subagents report only tool pulses, never thinking — so between tools the
// last one stays on screen instead of flickering to "Thinking…".
export function subagentActivity(run) {
  const tools = run.tools ?? [];
  const last = tools.findLast((t) => t.running) ?? tools.at(-1);
  if (!last) return "Thinking…";
  const { verb, file } = getToolView(last.name).runningLabel(last);
  return file ? `${verb} ${file}` : verb;
}

export function SubagentMeta({ run, now }) {
  const { text, tone } = subagentMeta(run, now);
  return <span className={"sa-meta sa-meta--" + tone}>{text}</span>;
}
