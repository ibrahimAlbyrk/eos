import { BranchConfirmDialog } from "../popovers/BranchConfirmDialog.jsx";
import { answerSubagentStop, useSubagentStopRequest } from "../../../state/subagentStopConfirm.js";

const COPY = {
  rewind: { doing: "Rewinding", confirm: "Stop & rewind" },
  compact: { doing: "Compacting", confirm: "Stop & compact" },
};

export function subagentStopMessage({ action, count, workflows = 0 }) {
  const plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const what = [count > 0 && plural(count, "subagent"), workflows > 0 && plural(workflows, "workflow")].filter(Boolean).join(" and ");
  const one = count + workflows === 1;
  return `${what} ${one ? "is" : "are"} still running. ${COPY[action].doing} restarts the session and stops ${one ? "it" : "them"}.`;
}

export function SubagentStopDialog() {
  const request = useSubagentStopRequest();
  if (!request) return null;
  return (
    <BranchConfirmDialog
      message={subagentStopMessage(request)}
      confirmLabel={COPY[request.action].confirm}
      danger
      onConfirm={() => answerSubagentStop(true)}
      onCancel={() => answerSubagentStop(false)}
    />
  );
}
