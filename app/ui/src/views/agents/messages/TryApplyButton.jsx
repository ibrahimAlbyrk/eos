// Apply / Sync action for an isolated worker's worktree changes. The phase
// machine and try info are owned by useTryState in the caller, so this is a pure
// renderer — letting the Changes panel and the orchestrator hub rows share one
// button with identical behavior. Caller gates rendering on `isolated`.
export function TryApplyButton({ tryState, applied, syncable, syncFiles, onApply, onResolveConflicts }) {
  if (tryState.phase === "applying") {
    return <button className="dv-act dv-act-apply" disabled>{applied ? "Syncing…" : "Applying…"}</button>;
  }
  if (tryState.phase === "conflicts") {
    return (
      <button
        className="dv-act dv-act-conflict"
        title={`${tryState.count} file(s) would conflict — nothing was touched`}
        onClick={onResolveConflicts}
      >
        Resolve with git agent
      </button>
    );
  }
  if (tryState.phase === "error") {
    return (
      <button className="dv-act dv-act-err" title="Click to retry" onClick={onApply}>
        {tryState.msg}
      </button>
    );
  }
  // idle: once applied, the button only returns to re-sync new worktree progress
  if (applied && !syncable) return null;
  return (
    <button
      className="dv-act dv-act-apply"
      title={applied
        ? "Pull the worker's new changes into your checkout (only the delta since you last applied)"
        : "Apply these changes as unstaged edits in your checkout (Keep/Discard after testing)"}
      onClick={onApply}
    >
      {applied ? `Sync changes${syncFiles.length ? ` (${syncFiles.length})` : ""}` : "Apply"}
    </button>
  );
}
