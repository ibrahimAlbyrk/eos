import { useEffect, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { revalidate } from "../../../state/gitStatusStore.js";
import { BranchContextMenu } from "./BranchContextMenu.jsx";
import { BranchConfirmDialog } from "./BranchConfirmDialog.jsx";
import { SearchField } from "./SearchField.jsx";
import {
  PlusIcon, FetchIcon, TrashIcon, PencilIcon, CopyIcon,
  CloudIcon, CheckIcon, SpinnerIcon,
} from "../../../lib/gitIconKit.jsx";

const EMPTY = { branches: [], remoteBranches: [], remotes: [], current: null };

// In-app branch manager: list/checkout local + remote branches, create / rename
// / delete locally, delete on the remote, and fetch — all without leaving Eos.
// Scoped to the composer's chosen folder (cwd). Replaces the old read-only
// BranchDropdown; reuses its glass shell + positioning (.cb-chip-dd--branch).
export function BranchManager({ live, cwd }) {
  const ui = useUi();
  const [data, setData] = useState(EMPTY);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState(null);   // branch being renamed
  const [renameValue, setRenameValue] = useState("");
  const [confirm, setConfirm] = useState(null);      // { kind, branch, remote? }
  const [ctx, setCtx] = useState(null);              // { x, y, label, isRemote }
  const [showRemote, setShowRemote] = useState(true);

  const open = ui.openPopover === "branch-dd";
  const composerBranch = ui.composer.branch;
  const setComposerBranch = (b) => ui.updateComposer({ branch: b });

  async function reload() {
    if (!cwd) { setData(EMPTY); return; }
    const r = await api.listBranches(cwd, { remotes: true });
    setData({
      branches: r.branches ?? [],
      remoteBranches: r.remoteBranches ?? [],
      remotes: r.remotes ?? [],
      current: r.current ?? null,
    });
    if (!composerBranch && r.current) setComposerBranch(r.current);
  }

  useEffect(() => {
    if (!open || !cwd) return;
    setFilter(""); setError(""); setCreating(false); setRenaming(null); setConfirm(null);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cwd]);

  if (!open) return null;

  const stripRemote = (label) => {
    for (const rm of data.remotes) if (label.startsWith(rm + "/")) return label.slice(rm.length + 1);
    return label;
  };

  // Push the new git state to the composer git row of the selected worker.
  const refreshRow = () => {
    const w = live.workers.find((x) => x.id === ui.selectedId);
    if (w) revalidate(ui.selectedId, w.worktree_dir ?? w.cwd ?? w.worktree_from);
  };

  const copyName = async (label) => {
    try { await navigator.clipboard.writeText(label); } catch { /* clipboard unavailable */ }
  };

  const checkout = async (label, isRemote) => {
    const short = isRemote ? stripRemote(label) : label;
    if (short === data.current) { setComposerBranch(short); ui.closeAllPops(); return; }
    setBusy(true);
    // Send the short name: `git checkout <name>` DWIM-creates a local tracking
    // branch from a remote ref instead of detaching HEAD on "origin/<name>".
    const res = await api.checkout(cwd, short);
    setBusy(false);
    if (res?.body?.ok) {
      setComposerBranch(short);
      refreshRow();
      ui.closeAllPops();
    } else if (res?.body?.dirty) {
      // Uncommitted changes block the switch — offer Stash & switch instead of
      // surfacing a raw git error dump.
      setError("");
      setConfirm({ kind: "stash-switch", branch: short });
    } else {
      setError(res?.body?.error || "Checkout failed");
    }
  };

  const submitCreate = async () => {
    const name = newName.trim();
    if (!name) { setCreating(false); return; }
    setBusy(true);
    const res = await api.createBranch(cwd, name, { checkout: true });
    setBusy(false);
    if (res?.body?.ok) {
      setCreating(false); setNewName(""); setError("");
      setComposerBranch(res.body.branch ?? name);
      refreshRow();
      reload();
    } else {
      setError(res?.body?.error || "Could not create branch");
    }
  };

  const submitRename = async (from) => {
    const to = renameValue.trim();
    if (!to || to === from) { setRenaming(null); return; }
    setBusy(true);
    const res = await api.renameBranch(cwd, from, to);
    setBusy(false);
    if (res?.body?.ok) {
      setRenaming(null); setError("");
      if (from === data.current) setComposerBranch(to);
      if (composerBranch === from) setComposerBranch(to);
      refreshRow();
      reload();
    } else {
      setError(res?.body?.error || "Could not rename branch");
    }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    if (confirm.kind === "stash-switch") {
      const res = await api.checkout(cwd, confirm.branch, { stash: true });
      setBusy(false);
      if (res?.body?.ok) {
        setConfirm(null); setError("");
        setComposerBranch(confirm.branch); refreshRow(); ui.closeAllPops();
      } else {
        setError(res?.body?.error || "Could not switch branch");
      }
      return;
    }
    if (confirm.kind === "delete-remote") {
      const res = await api.deleteRemoteBranch(cwd, confirm.remote, confirm.branch);
      setBusy(false);
      if (res?.body?.ok) { setConfirm(null); setError(""); reload(); }
      else setError(res?.body?.error || "Could not delete remote branch");
      return;
    }
    const force = confirm.kind === "force-delete";
    const res = await api.deleteBranch(cwd, confirm.branch, { force });
    setBusy(false);
    if (res?.body?.ok) { setConfirm(null); setError(""); refreshRow(); reload(); }
    else if (res?.body?.notMerged) setConfirm({ kind: "force-delete", branch: confirm.branch });
    else setError(res?.body?.error || "Could not delete branch");
  };

  const fetchRemote = async () => {
    setBusy(true);
    const res = await api.fetchRemote(cwd);
    setBusy(false);
    if (res?.body?.ok) { setError(""); reload(); }
    else setError(res?.body?.error || "Fetch failed");
  };

  const openCtx = (e, label, isRemote) => {
    e.preventDefault();
    setCtx({ x: e.clientX, y: e.clientY, label, isRemote });
  };

  // Left-click on a row already checks out, so the context menu has no Checkout
  // entry — it's for the actions a click can't do (copy / rename / delete).
  const ctxItems = (() => {
    if (!ctx) return [];
    if (ctx.isRemote) {
      return [
        { label: "Copy name", icon: <CopyIcon />, onClick: () => copyName(ctx.label) },
        "sep",
        { label: "Delete on remote…", icon: <TrashIcon />, danger: true,
          onClick: () => setConfirm({ kind: "delete-remote", branch: stripRemote(ctx.label), remote: ctx.label.split("/")[0] }) },
      ];
    }
    const isCurrent = ctx.label === data.current;
    const items = [
      { label: "Copy name", icon: <CopyIcon />, onClick: () => copyName(ctx.label) },
      { label: "Rename…", icon: <PencilIcon />, kbd: "R",
        onClick: () => { setRenaming(ctx.label); setRenameValue(ctx.label); } },
    ];
    if (!isCurrent) {
      items.push("sep", {
        label: "Delete", icon: <TrashIcon />, danger: true,
        onClick: () => setConfirm({ kind: "delete", branch: ctx.label }),
      });
    }
    return items;
  })();

  const q = filter.toLowerCase();
  const locals = q ? data.branches.filter((b) => b.toLowerCase().includes(q)) : data.branches;
  const remotes = q ? data.remoteBranches.filter((b) => b.toLowerCase().includes(q)) : data.remoteBranches;

  const confirmMsg = confirm && (
    confirm.kind === "stash-switch" ? `Uncommitted changes are blocking the switch to "${confirm.branch}". Stash them and switch?`
    : confirm.kind === "delete-remote" ? `Delete "${confirm.branch}" on the remote? This cannot be undone.`
    : confirm.kind === "force-delete" ? `"${confirm.branch}" isn't fully merged. Force delete? Commits may be lost.`
    : `Delete branch "${confirm.branch}"?`
  );
  const confirmLabel = confirm && (
    confirm.kind === "stash-switch" ? "Stash & switch"
    : confirm.kind === "force-delete" ? "Force delete"
    : "Delete"
  );
  const confirmDanger = Boolean(confirm) && confirm.kind !== "stash-switch";

  return (
    <div className="cb-chip-dd cb-chip-dd--branch branch-mgr open" id="cbBranchDD" data-popover="branch-dd">
      <div className="bm-header">
        <span className="bm-title">Branches</span>
        <span className="bm-grow" />
        <button className="bm-iconbtn" title="Fetch from remote" disabled={busy} onClick={fetchRemote}>
          {busy ? <SpinnerIcon /> : <FetchIcon />}
        </button>
        <button
          className="bm-iconbtn"
          title="New branch"
          onClick={() => { setCreating((v) => !v); setNewName(""); setError(""); }}
        >
          <PlusIcon />
        </button>
      </div>

      {error && <div className="bm-error">{error}</div>}

      {creating && (
        <div className="bm-create">
          <input
            autoFocus
            placeholder="new-branch-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCreate();
              if (e.key === "Escape") { e.stopPropagation(); setCreating(false); }
            }}
          />
          <span className="bm-create-hint">from {data.current ?? "HEAD"}</span>
        </div>
      )}

      <div className="cb-chip-dd-scroll">
        {locals.length === 0 && remotes.length === 0 && (
          <div className="bm-empty">{cwd ? "No branches" : "Pick a folder first"}</div>
        )}

        {locals.length > 0 && <div className="bm-section">Local</div>}
        {locals.map((b) => (
          renaming === b ? (
            <div key={b} className="bm-create bm-rename-row">
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitRename(b);
                  if (e.key === "Escape") { e.stopPropagation(); setRenaming(null); }
                }}
                onBlur={() => setRenaming(null)}
              />
            </div>
          ) : (
            <button
              key={b}
              className={"sp-chip-dd-item" + ((composerBranch ?? data.current) === b ? " on" : "")}
              onClick={() => checkout(b, false)}
              onContextMenu={(e) => openCtx(e, b, false)}
            >
              <span className="cb-branch-name" title={b}>{b}</span>
              <span className="check"><CheckIcon size={11} /></span>
            </button>
          )
        ))}

        {remotes.length > 0 && (
          <div className="bm-section bm-section-btn" onClick={() => setShowRemote((v) => !v)}>
            <span>Remote</span>
            <svg className={"bm-caret" + (showRemote ? " open" : "")} width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7">
              <path d="m4 6 4 4 4-4" />
            </svg>
          </div>
        )}
        {showRemote && remotes.map((b) => (
          <button
            key={b}
            className="sp-chip-dd-item bm-remote-row"
            onClick={() => checkout(b, true)}
            onContextMenu={(e) => openCtx(e, b, true)}
            title={`Checkout ${b} as a tracking branch`}
          >
            <CloudIcon size={11} />
            <span className="cb-branch-name">{b}</span>
          </button>
        ))}
      </div>

      <SearchField value={filter} onChange={setFilter} placeholder="Search branches…" />

      {ctx && <BranchContextMenu x={ctx.x} y={ctx.y} items={ctxItems} onClose={() => setCtx(null)} />}
      {confirm && (
        <BranchConfirmDialog
          message={confirmMsg}
          confirmLabel={confirmLabel}
          danger={confirmDanger}
          busy={busy}
          onConfirm={runConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
