import { BranchConfirmDialog } from "../popovers/BranchConfirmDialog.jsx";
import { answerModelSummary, useModelSummaryRequest } from "../../../state/modelSummaryConfirm.js";
import { contextUsage } from "../../../lib/contextWindow.js";
import { fmtTokens } from "../../../lib/format.js";
import { modelName } from "../../../lib/models.js";

export function modelSummaryMessage({ worker, model }) {
  const name = modelName(model) ?? model;
  const { used, total } = contextUsage(worker, model);
  const size = used > total
    ? `This conversation (~${fmtTokens(used)} tokens) doesn't fit ${name}'s ${fmtTokens(total)} context.`
    : `This conversation doesn't fit ${name}'s context.`;
  return `${size} To switch, it is summarized first with the current model, and ${name} continues from the summary.`;
}

export function ModelSummaryDialog() {
  const request = useModelSummaryRequest();
  if (!request) return null;
  return (
    <BranchConfirmDialog
      message={modelSummaryMessage(request)}
      confirmLabel="Summarize & switch"
      onConfirm={() => answerModelSummary(true)}
      onCancel={() => answerModelSummary(false)}
    />
  );
}
