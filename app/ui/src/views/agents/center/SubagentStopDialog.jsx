import { BranchConfirmDialog } from "../popovers/BranchConfirmDialog.jsx";
import { answerSubagentStop, useSubagentStopRequest } from "../../../state/subagentStopConfirm.js";

const COPY = {
  rewind: { doing: "Rewinding", confirm: "Stop & rewind" },
  compact: { doing: "Compacting", confirm: "Stop & compact" },
};

export function subagentStopMessage({ action, count }) {
  const one = count === 1;
  return `${count} subagent${one ? " is" : "s are"} still running. ${COPY[action].doing} restarts the session and stops ${one ? "it" : "them"}.`;
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
