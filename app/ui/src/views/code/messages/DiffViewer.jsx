import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { parsePatch } from "../../../lib/patch.js";
import { inlineDiffRanges } from "../../../lib/diff.jsx";
import { highlightAsync } from "../../../lib/asyncHighlight.js";
import { spawnMergeGitAgent } from "../../../lib/spawnMergeGitAgent.js";
import { useWorkerVerdict } from "../../../hooks/useWorkerVerdict.js";
import { useWorkerChanges } from "../../../hooks/useWorkerChanges.js";
import { useTryState } from "../../../hooks/useTryState.js";
import { workerGitDir } from "../../../lib/workerGitDir.js";
import { TryApplyButton } from "./TryApplyButton.jsx";
import { notify } from "../../../lib/notify.js";
import { PanelCloseButton } from "./PanelCloseButton.jsx";

// Initial row budget per file; further rows stream in as the sentinel below
// the rendered window scrolls into reach — no all-at-once "Show all" commit.
const MAX_ROWS = 300;
const CHUNK_ROWS = 400;

// Above this many changed lines a diff counts as "large": every file starts
// collapsed and the hint row appears. Small diffs stay expanded by default.
const LARGE_DIFF_LINES = 1000;

function splitPath(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? ["", path] : [path.slice(0, i + 1), path.slice(i + 1)];
}

export function DiffViewer({ live }) {
  const ui = useUi();
  // Mounted while anywhere in the panel stack (state survives a file viewer
  // pushed on top); visible only when on top.
  const open = Boolean(ui.diffViewer);
  return (
    <div className="diff-viewer dv-open">
      {open && <DiffViewerInner workerId={ui.diffViewer.workerId} live={live} />}
    </div>
  );
}

function DiffViewerInner({ workerId, live }) {
  const ui = useUi();
  // Cached snapshot renders synchronously; revalidation + SSE debounce live
  // in the diffStore (stale-while-revalidate).
  const { changes, patches, loadPatch, refresh } = useWorkerChanges(workerId, live);
  // The set tracks what is collapsed. Small diffs start empty (all expanded);
  // large diffs start with every file collapsed (see the init effect below).
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [discardErr, setDiscardErr] = useState(null);
  useEffect(() => { setCollapsed(new Set()); setDiscardErr(null); }, [workerId]);

  const totalChanged = (changes?.insertions || 0) + (changes?.deletions || 0);
  const isLargeDiff = totalChanged >= LARGE_DIFF_LINES;

  // Once the first changes snapshot for a worker arrives, collapse every file
  // when the diff is large. Keyed by workerId so later SSE refreshes keep the
  // user's manual expand/collapse state instead of re-collapsing.
  const initedFor = useRef(null);
  useEffect(() => {
    if (!changes || initedFor.current === workerId) return;
    initedFor.current = workerId;
    if (isLargeDiff) setCollapsed(new Set((changes.files || []).map((f) => f.path)));
  }, [changes, workerId, isLargeDiff]);

  // Load the patch of every open file that has none yet — covers the initial
  // list, files arriving via SSE refresh, and re-expanding after an error.
  useEffect(() => {
    for (const f of changes?.files ?? []) {
      if (collapsed.has(f.path)) continue;
      const p = patches.get(f.path);
      if (!p?.data && !p?.loading) loadPatch(f);
    }
  }, [changes, collapsed, patches, loadPatch]);

  const worker = live.workers.find((w) => w.id === workerId);
  const isolated = Boolean(worker?.worktree_from && worker?.branch);
  const { tryState, appliedHere, kept, syncable, syncFiles, applyTry } = useTryState(workerId, isolated, live);
  // Already in the checkout (provisional layer or kept). Apply then becomes a
  // re-sync that pulls only the worker's new worktree progress.
  const applied = appliedHere || kept;

  // Stable identity so memoized FileCards don't re-render on sibling updates.
  const toggle = useCallback((file) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(file.path)) next.delete(file.path); else next.add(file.path);
      return next;
    });
  }, []);

  const files = changes?.files ?? [];
  const ready = changes !== null;

  // Own verdict when this worker is selected (Messages publishes it);
  // otherwise derive from the worker's own transcript (hub opens children's
  // viewers without changing selection), with the report-parsed Handover as
  // the last fallback.
  const selectedVerdict = ui.verdict?.workerId === workerId ? ui.verdict : null;
  const derived = useWorkerVerdict(workerId, live, { enabled: !selectedVerdict });
  const verdict = selectedVerdict
    ?? (derived && derived.verdict !== "unverified" ? derived : null)
    ?? (ui.verdict?.children?.[workerId] ?? null);
  const showVerdict = verdict && verdict.verdict !== "unverified";
  const gitDir = workerGitDir(worker);

  const openFile = useCallback((f) => {
    if (gitDir) ui.openFileViewer(gitDir + "/" + f.path);
  }, [gitDir, ui.openFileViewer]);

  // Revert one file to the diff base (the daemon re-derives its status). On
  // success the row vanishes on the next changes refresh; on failure we surface
  // git's reason in the header.
  const onDiscard = useCallback(async (file) => {
    setDiscardErr(null);
    const r = await api.discardFile(workerId, file.path);
    if (r.ok) { refresh(); return; }
    setDiscardErr(r.body?.error || "Discard failed");
  }, [workerId, refresh]);

  const base = worker?.worktree_from;
  const head = worker?.branch;

  return (
    <>
      <div className="dv-head">
        <span className="dv-crumb" title={base ? `${base} → ${head}` : undefined}>
          <svg className="dv-crumb-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M2 5a1 1 0 0 1 1-1h3l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z" />
          </svg>
          {base && head ? (
            <>
              <span className="dv-crumb-ref">{base}</span>
              <span className="dv-crumb-arrow">→</span>
              <span className="dv-crumb-ref dv-crumb-head">{head}</span>
            </>
          ) : (
            <span className="dv-crumb-ref">{head || "Changes"}</span>
          )}
        </span>
        <span className="dv-grow" />
        {showVerdict && (
          <span className={"git-chip verdict-chip verdict-" + verdict.verdict} title={verdict.command ? `verified by: ${verdict.command}` : undefined}>
            <span className="lbl">{verdict.verdict}</span>
          </span>
        )}
        {isolated && (appliedHere || kept) && (
          <span className="git-chip applied-chip" title={kept ? "These changes were applied to your checkout and kept" : "These changes are currently applied in your checkout (Keep/Discard in the banner)"}>
            <span className="lbl">applied</span>
          </span>
        )}
        {discardErr && <span className="dv-act-err" title={discardErr}>{discardErr}</span>}
        {isolated && (
          <TryApplyButton
            tryState={tryState}
            applied={applied}
            syncable={syncable}
            syncFiles={syncFiles}
            onApply={applyTry}
            onResolveConflicts={() => spawnMergeGitAgent(worker, live, ui)}
          />
        )}
        {gitDir && (
          <button
            className="fv-icon-btn"
            title="Reveal workspace in Finder"
            onClick={() => api.revealFile(gitDir)}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M2 5a1 1 0 0 1 1-1h3l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z" />
            </svg>
          </button>
        )}
        {gitDir && (
          <button
            className="fv-icon-btn"
            title="Copy workspace path"
            onClick={async () => { await navigator.clipboard?.writeText(gitDir); notify.info('Workspace path copied'); }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
              <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
            </svg>
          </button>
        )}
        <PanelCloseButton onClose={ui.closeDiffViewer} />
      </div>
      {isLargeDiff && (
        <div className="dv-hint">Large diff — files start collapsed. Click a file header to expand it.</div>
      )}
      <div className="dv-list">
        {!ready && <div className="dv-empty">Loading...</div>}
        {ready && files.length === 0 && <div className="dv-empty">Working tree clean</div>}
        {ready && files.map((f) => (
          <FileCard
            key={f.path}
            file={f}
            isOpen={!collapsed.has(f.path)}
            patch={patches.get(f.path)}
            onToggle={toggle}
            onOpenFile={gitDir ? openFile : undefined}
            onDiscard={onDiscard}
          />
        ))}
      </div>
    </>
  );
}

const FileCard = memo(function FileCard({ file, isOpen, patch, onToggle, onOpenFile, onDiscard }) {
  const [dir, base] = splitPath(file.path);
  // Deleted files have nothing on disk to open.
  const openable = Boolean(onOpenFile) && file.status !== "D";
  // Two-step inline confirm (no native confirm() — it's a no-op in the WKWebView
  // shell); leaving the row disarms it.
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const discard = async () => {
    setBusy(true);
    await onDiscard(file);
    setBusy(false);
    setConfirming(false);
  };
  return (
    <div
      className={"dv-file" + (isOpen ? " open" : "")}
      onMouseLeave={() => { if (!busy) setConfirming(false); }}
    >
      <button className="dv-row" onClick={() => onToggle(file)}>
        <svg className="dv-chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 4 4 4-4 4" />
        </svg>
        <span
          className={"dv-path" + (openable ? " dv-openable" : "")}
          title={file.oldPath ? `${file.oldPath} → ${file.path}` : (openable ? "Open file" : undefined)}
          onClick={openable ? (e) => { e.stopPropagation(); onOpenFile(file); } : undefined}
        >
          {dir && <span className="dv-dir">{dir}</span>}
          <span className="dv-base">{base}</span>
        </span>
        <span className="dv-counts">
          {file.untracked ? (
            <span className="dv-new">new</span>
          ) : file.insertions === null ? (
            <span className="dv-bin">bin</span>
          ) : (
            <>
              {file.insertions > 0 && <span className="dv-add">+{file.insertions}</span>}
              {file.deletions > 0 && <span className="dv-del">−{file.deletions}</span>}
            </>
          )}
        </span>
        <span className="dv-grow" />
        {onDiscard && (
          confirming ? (
            <span className="dv-discard-confirm">
              <span className="dv-discard-yes" title="Discard these changes — revert to the base version" onClick={(e) => { e.stopPropagation(); if (!busy) discard(); }}>
                {busy ? "…" : "Discard"}
              </span>
              <span className="dv-discard-no" title="Cancel" onClick={(e) => { e.stopPropagation(); setConfirming(false); }}>Cancel</span>
            </span>
          ) : (
            <span className="dv-discard" title="Discard changes — revert this file to the base version" onClick={(e) => { e.stopPropagation(); setConfirming(true); }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 3.5 2 6.5l3 3" />
                <path d="M2 6.5h6.5a4 4 0 0 1 0 8H5" />
              </svg>
            </span>
          )
        )}
      </button>
      {isOpen && <PatchBody file={file} patch={patch} />}
    </div>
  );
});

// Align worker-highlighted blocks back onto hunk rows. Each hunk's old side
// (ctx+del) and new side (ctx+add) are highlighted as separate blocks so
// multi-line constructs keep their context within the hunk.
function alignRich(hunk, oldHL, newHL) {
  let oi = 0, ni = 0;
  return hunk.rows.map((r) => {
    if (r.type === "del") return oldHL?.[oi++] ?? null;
    if (r.type === "add") return newHL?.[ni++] ?? null;
    oi++;
    return newHL?.[ni++] ?? null;
  });
}

// Word-level intra-line highlight: pair each hunk's contiguous del-run with the
// following add-run (index-wise, same as buildDiffHunks) and record the changed
// char span per row. Returned parallel to hunk.rows; null where nothing changed.
function wordRangesFor(rows) {
  const ranges = new Array(rows.length).fill(null);
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type !== "del") { i++; continue; }
    const delStart = i;
    while (i < rows.length && rows[i].type === "del") i++;
    const addStart = i;
    while (i < rows.length && rows[i].type === "add") i++;
    const pairs = Math.min(addStart - delStart, i - addStart);
    for (let p = 0; p < pairs; p++) {
      const d = rows[delStart + p], a = rows[addStart + p];
      const { delStart: ds, delEnd: de, addStart: as, addEnd: ae } = inlineDiffRanges(d.text, a.text);
      if (de > ds) ranges[delStart + p] = { start: ds, end: de };
      if (ae > as) ranges[addStart + p] = { start: as, end: ae };
    }
  }
  return ranges;
}

// Render syntax tokens for one line, overlaying a single continuous word-diff
// background across [hlStart, hlEnd). Syntax color stays on the inner spans, so
// both highlights compose. `tokens` may be the plain single-token fallback
// ([{ t: text }]) when the async syntax pass has not answered yet.
function renderTokens(tokens, hlStart, hlEnd, hlClass) {
  if (hlStart == null) {
    return tokens.map((tok, k) => (tok.c ? <span key={k} className={tok.c}>{tok.t}</span> : tok.t));
  }
  const pre = [], mid = [], post = [];
  let pos = 0;
  tokens.forEach((tok, k) => {
    const text = tok.t ?? "";
    if (!text) return;
    const start = pos, end = pos + text.length;
    pos = end;
    const emit = (bucket, s, e, tag) => {
      if (e <= s) return;
      const slice = text.slice(s - start, e - start);
      bucket.push(tok.c ? <span key={String(k) + tag} className={tok.c}>{slice}</span> : slice);
    };
    emit(pre, start, Math.min(end, hlStart), "a");
    emit(mid, Math.max(start, hlStart), Math.min(end, hlEnd), "b");
    emit(post, Math.max(start, hlEnd), end, "c");
  });
  return (
    <>
      {pre}
      {mid.length > 0 && <span className={hlClass}>{mid}</span>}
      {post}
    </>
  );
}

function PatchBody({ file, patch }) {
  const data = patch?.data;
  const hunks = useMemo(
    () => (data && !data.binary ? parsePatch(data.patch) : []),
    [data],
  );
  const wordRanges = useMemo(() => hunks.map((h) => wordRangesFor(h.rows)), [hunks]);

  // rich.perHunk[i][j] = token line for hunks[i].rows[j]; arrives async from
  // the highlight worker — rows paint as plain text immediately and colorize
  // when the worker answers. Carries its hunks reference so a refreshed patch
  // never renders stale tokens onto new rows.
  const [rich, setRich] = useState(null);
  useEffect(() => {
    if (!hunks.length) { setRich(null); return; }
    let cancelled = false;
    Promise.all(hunks.map(async (h) => {
      const oldRows = h.rows.filter((r) => r.type !== "add");
      const newRows = h.rows.filter((r) => r.type !== "del");
      const [oldHL, newHL] = await Promise.all([
        highlightAsync(oldRows.map((r) => r.text).join("\n"), file.path),
        highlightAsync(newRows.map((r) => r.text).join("\n"), file.path),
      ]);
      return alignRich(h, oldHL, newHL);
    })).then((perHunk) => {
      if (!cancelled) setRich({ hunks, perHunk });
    });
    return () => { cancelled = true; };
  }, [hunks, file.path]);
  const perHunk = rich?.hunks === hunks ? rich.perHunk : null;

  const totalRows = useMemo(() => hunks.reduce((n, h) => n + h.rows.length, 0), [hunks]);
  const [budget, setBudget] = useState(MAX_ROWS);
  const needMore = totalRows > budget;
  const sentinelRef = useRef(null);
  // Recreate the observer per budget step: a fresh observe() always reports
  // the current intersection, so a sentinel still inside the preload margin
  // keeps cascading CHUNK_ROWS-sized commits until it falls out of reach.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((es) => {
      if (es.some((x) => x.isIntersecting)) setBudget((b) => b + CHUNK_ROWS);
    }, { rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, [needMore, budget]);

  // Stale-while-revalidate: keep showing the previous patch while a refresh
  // is inflight; only fall back to the note when there is nothing to show.
  if (!data) {
    if (patch?.error) return <div className="dv-patch-note dv-patch-err">{patch.error}</div>;
    return <div className="dv-patch-note">Loading diff...</div>;
  }
  if (data.binary) return <div className="dv-patch-note">Binary file</div>;
  if (hunks.length === 0) return <div className="dv-patch-note">No textual changes</div>;

  let left = budget;

  return (
    <div className="dv-patch">
      {hunks.map((h, i) => {
        if (left <= 0) return null;
        const rows = h.rows.length > left ? h.rows.slice(0, left) : h.rows;
        left -= rows.length;
        return (
          <div
            className="dv-hunk-block"
            key={i}
            style={{ containIntrinsicSize: `auto ${rows.length * 21 + 26}px` }}
          >
            <div className="dv-hunk">{h.header}</div>
            {rows.map((r, j) => {
              const tokens = perHunk?.[i]?.[j] ?? [{ t: r.text }];
              const range = wordRanges[i]?.[j];
              const hlClass = r.type === "del" ? "ed-hl-del" : "ed-hl-add";
              return (
                <div className={"dvr dvr-" + r.type} key={j}>
                  <span className="dvr-num">{r.num}</span>
                  <span className="dvr-code">
                    {renderTokens(tokens, range?.start ?? null, range?.end, hlClass)}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
      {needMore && (
        <div ref={sentinelRef} className="dv-patch-note">
          {(totalRows - budget).toLocaleString()} more lines…
        </div>
      )}
      {data.truncated && <div className="dv-patch-note">Diff truncated</div>}
    </div>
  );
}
