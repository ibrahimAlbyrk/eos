import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { notify } from "../../../lib/notify.js";
import { subscribeGitChange, STASH_KINDS, GIT_FALLBACK_POLL_MS } from "../../../state/gitChangeBus.js";
import { fmtTimeAgo } from "../../../lib/format.js";
import { BranchConfirmDialog } from "../popovers/BranchConfirmDialog.jsx";

// Sidebar stashes section (near History). Each row scopes the panel to that
// stash's diff via the commit-scope path (its sha diffs first-parent server
// side, so image before/after works unchanged). Right-click → Apply / Delete;
// Delete (git stash drop, irreversible) is guarded by the shared confirm modal
// (BranchConfirmDialog idiom). Hidden entirely when the repo has no stashes.
// Refreshes on the git-change bus "stash" kind with the shared poll backstop;
// also re-fetches immediately after an Apply/Delete so the row updates even if
// the bus lags.
export function GitDiffStashes({ cwd, scope, onScope, focusOnMount }) {
  const ui = useUi();
  const [stashes, setStashes] = useState(null);
  const [confirm, setConfirm] = useState(null); // { index, subject }
  const [busy, setBusy] = useState(false);
  const rootRef = useRef(null);

  // Opened via the composer stash chip: select the most-recent stash (stash@{0})
  // so this section reads as active — its row highlights and the panel shows its
  // diff — then scroll it into view. One-shot: clear the ref so a later refresh
  // doesn't re-select or yank the scroll back.
  useEffect(() => {
    if (focusOnMount?.current && stashes && stashes.length > 0) {
      focusOnMount.current = false;
      const top = stashes[0];
      onScope({ kind: "commit", sha: top.sha, subject: top.subject });
      rootRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [stashes, focusOnMount, onScope]);

  const refetch = useCallback(async () => {
    const r = await api.getGitStashes(cwd);
    setStashes(r.stashes ?? []);
  }, [cwd]);

  useEffect(() => {
    setStashes(null);
    let cancelled = false;
    const run = async () => {
      const r = await api.getGitStashes(cwd);
      if (!cancelled) setStashes(r.stashes ?? []);
    };
    run();
    const t = setInterval(run, GIT_FALLBACK_POLL_MS);
    const unsub = subscribeGitChange(cwd, STASH_KINDS, run);
    return () => { cancelled = true; clearInterval(t); unsub(); };
  }, [cwd]);

  const openMenu = (e, s) => {
    e.preventDefault();
    ui.openPop("gitdiff-stash-ctx", { x: e.clientX, y: e.clientY, data: { index: s.index, sha: s.sha, subject: s.subject } });
  };

  const apply = async (index) => {
    ui.closeAllPops();
    const r = await api.stashApply(cwd, index);
    if (r.ok) notify.info("Stash applied"); else notify.error(r.body?.error ?? "Apply failed");
    refetch();
  };

  const askDrop = (data) => { ui.closeAllPops(); setConfirm({ index: data.index, subject: data.subject }); };

  const doDrop = async () => {
    if (busy) return;
    setBusy(true);
    const r = await api.stashDrop(cwd, confirm.index);
    setBusy(false);
    if (r.ok) notify.info("Stash dropped"); else notify.error(r.body?.error ?? "Drop failed");
    setConfirm(null);
    refetch();
  };

  // Hidden until loaded and only when non-empty — the section shouldn't take
  // sidebar space in the common no-stash repo. (The confirm modal is portal'd,
  // so an in-flight drop of the last stash still finishes even as this unmounts.)
  if (!stashes || stashes.length === 0) return null;

  return (
    <div className="gd-commits" ref={rootRef}>
      <div className="gd-commits-title">Stashes</div>
      <div className="gd-commits-list">
        {stashes.map((s) => (
          <button
            key={s.sha}
            className={"gd-commit" + (scope.kind === "commit" && scope.sha === s.sha ? " on" : "")}
            title={s.subject}
            onClick={() => onScope({ kind: "commit", sha: s.sha, subject: s.subject })}
            onContextMenu={(e) => openMenu(e, s)}
          >
            <span className="gd-commit-subject">stash@{"{"}{s.index}{"}"} · {s.subject}</span>
            <span className="gd-commit-meta">{fmtTimeAgo(s.ts)}{s.branch ? ` · ${s.branch}` : ""}</span>
          </button>
        ))}
      </div>
      <StashContextMenu onApply={apply} onDrop={askDrop} />
      {confirm && (
        <BranchConfirmDialog
          message={`Delete stash@{${confirm.index}}${confirm.subject ? ` — “${confirm.subject}”` : ""}? This can't be undone.`}
          confirmLabel={busy ? "Deleting…" : "Delete stash"}
          danger
          busy={busy}
          onConfirm={doDrop}
          onCancel={() => { if (!busy) setConfirm(null); }}
        />
      )}
    </div>
  );
}

// Portal'd to <body> (the panel sits in a contain:paint pane that would clip a
// position:fixed menu). Shared popover plumbing dismisses it via data-popover.
function StashContextMenu({ onApply, onDrop }) {
  const ui = useUi();
  if (ui.openPopover !== "gitdiff-stash-ctx") return null;
  const data = ui.popoverData ?? {};
  if (data.index == null) return null;

  const left = Math.min(ui.popoverPos.x, window.innerWidth - 220);
  const top = Math.min(ui.popoverPos.y, window.innerHeight - 96);

  return createPortal(
    <div className="ctx-menu glass-pop open" data-popover="gitdiff-stash-ctx" style={{ display: "block", left, top }}>
      <button className="menu-item" onClick={() => onApply(data.index)}>Apply</button>
      <button className="menu-item danger" onClick={() => onDrop(data)}>Delete</button>
    </div>,
    document.body,
  );
}
