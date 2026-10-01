// Open the pane's Subagents tab: one subagent's detail, or the list when
// toolUseId is null. workerId tags the selection so a pane that has since
// switched agents falls back to its own list instead of a stale detail.
export function openSubagents(ui, workerId, toolUseId = null) {
  ui.openPanel("subagents", { workerId, toolUseId });
}
