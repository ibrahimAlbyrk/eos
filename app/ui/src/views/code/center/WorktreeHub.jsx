import { useCallback, useEffect, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { workerGitDir } from "../../../lib/workerGitDir.js";
import { TryApplyButton } from "../messages/TryApplyButton.jsx";
import { useWorkerVerdict } from "../../../hooks/useWorkerVerdict.js";
import { useGitStatus } from "../../../hooks/useGitStatus.js";
import { useTryState } from "../../../hooks/useTryState.js";
import { hasUnintegratedWork } from "../../../lib/workState.js";
import { spawnMergeGitAgent } from "../../../lib/spawnMergeGitAgent.js";
import { loadExpandedHubs, saveExpandedHubs } from "../../../lib/hubExpandMemory.js";
import { AgentName } from "../../../lib/agentName.js";

// Orchestrator hub strip: one row per worktree child with unintegrated work.
// The user reviews/tests the whole fleet from the orchestrator screen — the
// badge opens that child's Changes panel (Verify lives in its header) without
// changing the selection, and Apply sits inline on the row (same button as the
// panel) so a worktree can be applied without opening it. Dirty is the ONLY
// reason a row exists; verdict/applied chips decorate existing work, they never
// resurrect a clean child's row.
function ChildIntegrationRow({ child, ui, live, onDirty }) {
  const gitDir = workerGitDir(child);
  const { status: gs } = useGitStatus(child.id, { gitDir });
  const isolated = Boolean(child.worktree_dir || (child.worktree_from && child.branch));
  const { tryState, appliedHere, kept, syncable, syncFiles, applyTry } = useTryState(child.id, isolated, live);
  const diff = gs?.diff ?? null;
  const dirty = hasUnintegratedWork(diff);
  const ins = diff?.insertions ?? 0;
  const del = diff?.deletions ?? 0;
  const files = diff?.files ?? 0;

  // Report this child's diff up (null when clean) so the parent can gate
  // "Merge all" on the count of children with changes AND total them in the
  // collapsed hub pill. Value-report and unmount-removal are split effects so a
  // diff refresh updates the entry in place instead of flicker-removing it.
  useEffect(() => {
    onDirty(child.id, dirty ? { insertions: ins, deletions: del, files } : null);
  }, [child.id, dirty, ins, del, files, onDirty]);
  useEffect(() => () => onDirty(child.id, null), [child.id, onDirty]);

  // Verdict from the child's OWN transcript (same selector as its own view —
  // covers a user-clicked /verify that produced no parent report); the
  // report-parsed Handover stays as fallback.
  const derived = useWorkerVerdict(child.id, live);
  const reported = ui.verdict?.children?.[child.id] ?? null;
  const verdict = derived && derived.verdict !== "unverified" ? derived : reported;
  const applied = appliedHere || kept;
  // Offer Apply only on a green run — don't one-click apply failing/unverified work from the hub.
  const passed = verdict?.verdict === "passed";
  if (!dirty) return null;

  // The diff panel is "viewing" this child when it's open for that worker.
  const viewing = ui.isPanelOpen("diff") && ui.diffViewer?.workerId === child.id;
  return (
    <div className="child-int-row">
      <span className="cir-name" title={child.branch ?? undefined}><AgentName worker={child} /></span>
      {verdict && verdict.verdict !== "unverified" && (
        <span className={"git-chip verdict-chip verdict-" + verdict.verdict} title={verdict.command ? `verified by: ${verdict.command}` : undefined}>
          <span className="lbl">{verdict.verdict}</span>
        </span>
      )}
      {applied && (
        <span className="git-chip applied-chip" title={kept ? "These changes were applied to your checkout and kept" : "These changes are currently applied in your checkout"}>
          <span className="lbl">applied</span>
        </span>
      )}
      <span className="diff-grow"></span>
      {isolated && passed && (
        <TryApplyButton
          tryState={tryState}
          applied={applied}
          syncable={syncable}
          syncFiles={syncFiles}
          onApply={applyTry}
          onResolveConflicts={() => spawnMergeGitAgent(child, live, ui)}
        />
      )}
      <button
        className={"diff-badge diff-badge-btn" + (viewing ? " on" : "")}
        title="Review, verify and try this worker's changes"
        onClick={() => (viewing ? ui.closeDiffViewer() : ui.openDiffViewer(child.id))}
      >
        {diff.insertions > 0 || diff.deletions > 0 ? (
          <>
            +{diff.insertions.toLocaleString()}{" "}
            <span className="diff-neg">−{diff.deletions.toLocaleString()}</span>
          </>
        ) : (
          <>{diff.files} new</>
        )}
      </button>
    </div>
  );
}

// Ambient worktree-fleet pill for an orchestrator: docked in-flow on the right of
// the ambient rail (next to the TaskTray), it reports the dirty-child summary up
// (drives the git row's "Merge all" + the footer mirror) and, when open, floats
// the child list up over the transcript so expanding never pushes the input.
// Hidden — but kept mounted so the git-status pollers keep reporting — when a
// blocking banner holds the slot, or when no child is dirty.
export function WorktreeHub({ live, selected, blockingActive, onStatus }) {
  const ui = useUi();

  // id → {insertions, deletions, files} for each child that has changes (absent
  // when clean). Powers the "Merge all" gate, the hub count, and the pill total.
  const [childDiffs, setChildDiffs] = useState(() => new Map());
  // Set of orchestrator ids the user explicitly expanded, persisted so the choice
  // survives Cmd+R and — since one shared composer serves every pane — keys on the
  // agent so each pane restores its own state on focus switch. Default is collapsed.
  const [expandedHubs, setExpandedHubs] = useState(() => loadExpandedHubs());
  useEffect(() => { saveExpandedHubs(expandedHubs); }, [expandedHubs]);
  const toggleHub = () => {
    if (!selected) return;
    setExpandedHubs((prev) => {
      const next = new Set(prev);
      if (next.has(selected.id)) next.delete(selected.id);
      else next.add(selected.id);
      return next;
    });
  };

  const reportChildDirty = useCallback((id, diff) => {
    setChildDiffs((prev) => {
      if (!diff) {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      }
      const cur = prev.get(id);
      if (cur && cur.insertions === diff.insertions && cur.deletions === diff.deletions && cur.files === diff.files) {
        return prev;
      }
      const next = new Map(prev);
      next.set(id, diff);
      return next;
    });
  }, []);

  const isOrchestrator = Boolean(selected?.is_orchestrator);
  const childWorkers = (selected && isOrchestrator)
    ? live.workers.filter((w) => w.parent_id === selected.id && w.worktree_from && w.branch)
    : [];
  const dirtyChildren = childWorkers.filter((w) => childDiffs.has(w.id));
  const hubTotals = dirtyChildren.reduce(
    (acc, w) => {
      const d = childDiffs.get(w.id);
      if (d) { acc.insertions += d.insertions; acc.deletions += d.deletions; acc.files += d.files; }
      return acc;
    },
    { insertions: 0, deletions: 0, files: 0 }
  );

  // Report the fleet summary up (children carry branch for "Merge all"). Keyed on
  // a string signature so the array identity churn doesn't refire the effect;
  // value-report and unmount-clear split so a diff refresh updates in place.
  const childKey = dirtyChildren.map((w) => `${w.id}:${w.branch}`).join(",");
  useEffect(() => {
    onStatus?.(
      dirtyChildren.length > 0
        ? {
            count: dirtyChildren.length,
            insertions: hubTotals.insertions,
            deletions: hubTotals.deletions,
            files: hubTotals.files,
            children: dirtyChildren.map((w) => ({ id: w.id, branch: w.branch })),
          }
        : null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onStatus, childKey, hubTotals.insertions, hubTotals.deletions, hubTotals.files]);
  useEffect(() => () => onStatus?.(null), [onStatus]);

  if (!selected || !isOrchestrator || childWorkers.length === 0) return null;

  const hubOpen = expandedHubs.has(selected.id);

  return (
    <div className={[
      "child-int-panel",
      hubOpen ? "open" : "collapsed",
      dirtyChildren.length === 0 ? "is-empty" : "",
      blockingActive ? "demoted" : "",
    ].filter(Boolean).join(" ")}>
      {/* list FIRST so it sits above the toggle pill; the bottom-anchored rail grows up */}
      <div className="child-int-list glass-pop">
        {childWorkers.map((w) => (
          <ChildIntegrationRow key={w.id} child={w} ui={ui} live={live} onDirty={reportChildDirty} />
        ))}
      </div>
      <button
        type="button"
        className="cint-toggle"
        onClick={toggleHub}
        title={hubOpen ? "Collapse worktree changes" : "Show worktree changes"}
      >
        <svg className="cint-ic" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
          <path d="M5.5 8h5M8 5.5v5" />
        </svg>
        <span className="cint-label">Worktrees</span>
        <span className="cint-count">{dirtyChildren.length}</span>
        <span className="cint-diff">
          {hubTotals.insertions > 0 || hubTotals.deletions > 0 ? (
            <>
              +{hubTotals.insertions.toLocaleString()}
              <span className="neg">−{hubTotals.deletions.toLocaleString()}</span>
            </>
          ) : (
            <>{hubTotals.files} new</>
          )}
        </span>
        <svg className="cint-chev" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d={hubOpen ? "M2 3.5L5 6.5L8 3.5" : "M2 6.5L5 3.5L8 6.5"} />
        </svg>
      </button>
    </div>
  );
}
