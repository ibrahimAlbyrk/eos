import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parsePatch } from "../../../lib/patch.js";
import { foldGaps, splitPairs } from "../../../lib/diffLayout.js";
import { inlineDiffRanges } from "../../../lib/diff.jsx";
import { highlightAsync } from "../../../lib/asyncHighlight.js";

// Initial row budget per file; further rows stream in as the sentinel below
// the rendered window scrolls into reach — no all-at-once "Show all" commit.
const MAX_ROWS = 300;
const CHUNK_ROWS = 400;

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

// One file's patch in the Changes panel. Between hunks, the unchanged lines git
// left out show as a fold ("N unmodified lines") that opens in place once the
// file's new side is loaded (`loadNewLines`). `split` lays rows side by side.
// With `onComment`, a line number opens a comment box under that row; a sent
// comment stays in place as a note.
export function PatchBody({ file, patch, split = false, loadNewLines = null, onComment = null }) {
  const data = patch?.data;
  const hunks = useMemo(
    () => (data && !data.binary ? parsePatch(data.patch) : []),
    [data],
  );
  const wordRanges = useMemo(() => hunks.map((h) => wordRangesFor(h.rows)), [hunks]);
  const gaps = useMemo(() => foldGaps(hunks), [hunks]);
  const pairs = useMemo(() => (split ? hunks.map(splitPairs) : null), [hunks, split]);

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

  // Folds: which are open, and the new side's lines once fetched for them.
  const [openFolds, setOpenFolds] = useState(() => new Set());
  const [newLines, setNewLines] = useState(null);
  const [foldBusy, setFoldBusy] = useState(false);
  const openFold = useCallback(async (i) => {
    if (!newLines) {
      setFoldBusy(true);
      const lines = await loadNewLines?.().catch(() => null);
      setFoldBusy(false);
      if (!lines) return;
      setNewLines(lines);
    }
    setOpenFolds((prev) => new Set(prev).add(i));
  }, [newLines, loadNewLines]);

  // Comments: the row being commented on, and what was already sent per row.
  const [composing, setComposing] = useState(null);
  const [sent, setSent] = useState(() => new Map());
  // Hunk/row indexes key the folds and notes — a changed patch starts fresh.
  const patchText = data?.patch;
  useEffect(() => {
    setOpenFolds(new Set());
    setNewLines(null);
    setComposing(null);
    setSent(new Map());
  }, [patchText]);
  const send = useCallback(async (key, row, text) => {
    const ok = await onComment({ row, text });
    if (!ok) return false;
    setSent((prev) => new Map(prev).set(key, [...(prev.get(key) ?? []), text]));
    setComposing(null);
    return true;
  }, [onComment]);

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
  const tokensOf = (i, j, r) => perHunk?.[i]?.[j] ?? [{ t: r.text }];
  const code = (i, j, r) => {
    const range = wordRanges[i]?.[j];
    return renderTokens(tokensOf(i, j, r), range?.start ?? null, range?.end, r.type === "del" ? "ed-hl-del" : "ed-hl-add");
  };
  const gutter = (key, row, num, cls = "dvr-num") => (onComment && num != null ? (
    <button type="button" className={cls + " dvr-num--btn"} title="Comment on this line" aria-label={`Comment on line ${num}`} onClick={() => setComposing(composing === key ? null : key)}>{num}</button>
  ) : <span className={cls}>{num ?? ""}</span>);
  const notes = (key, row) => (
    <>
      {(sent.get(key) ?? []).map((t, n) => <div key={n} className="dv-cmt-sent"><span className="dv-cmt-sent__tag">Sent to agent</span>{t}</div>)}
      {composing === key && <CommentBox onCancel={() => setComposing(null)} onSend={(text) => send(key, row, text)} />}
    </>
  );

  return (
    <div className={"dv-patch" + (split ? " dv-patch--split" : "")}>
      {hunks.map((h, i) => {
        if (left <= 0) return null;
        const count = split ? pairs[i].length : h.rows.length;
        const shown = Math.min(count, left);
        left -= shown;
        const gap = gaps[i];
        const gapOpen = gap && openFolds.has(i) && newLines;
        return (
          <div
            className="dv-hunk-block"
            key={i}
            style={{ containIntrinsicSize: `auto ${shown * 21 + 26}px` }}
          >
            {gap && !gapOpen && (
              <button type="button" className="dv-fold" disabled={!loadNewLines || foldBusy} onClick={() => openFold(i)}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m5 5.5 3-3 3 3M5 10.5l3 3 3-3" /></svg>
                <span>{gap.end - gap.start + 1} unmodified {gap.end === gap.start ? "line" : "lines"}</span>
                {h.context && <span className="dv-fold__ctx">{h.context}</span>}
              </button>
            )}
            {!gap && i > 0 && h.context && <div className="dv-hunk">{h.context}</div>}
            {gapOpen && newLines.slice(gap.start - 1, gap.end).map((text, k) => {
              const num = gap.start + k;
              const oldNum = num - (h.newStart - h.oldStart);
              return split ? (
                <div className="dvs" key={`g${k}`}>
                  <span className="dvr-num">{oldNum}</span><span className="dvr-code">{text}</span>
                  <span className="dvr-num">{num}</span><span className="dvr-code">{text}</span>
                </div>
              ) : (
                <div className="dvr dvr-ctx" key={`g${k}`}><span className="dvr-num">{num}</span><span className="dvr-code">{text}</span></div>
              );
            })}
            {split
              ? pairs[i].slice(0, shown).map((p, k) => {
                const anchor = p.right ?? p.left;
                const key = `${i}:${anchor.j}`;
                return (
                  <div key={k} className="dvs-wrap">
                    <div className="dvs">
                      {p.left ? <>{gutter(key, p.left.row, p.left.num, "dvr-num" + (p.left.row.type === "del" ? " dvs-del" : ""))}<span className={"dvr-code" + (p.left.row.type === "del" ? " dvs-del" : "")}>{code(i, p.left.j, p.left.row)}</span></> : <><span className="dvr-num dvs-empty" /><span className="dvr-code dvs-empty" /></>}
                      {p.right ? <>{gutter(key, p.right.row, p.right.num, "dvr-num" + (p.right.row.type === "add" ? " dvs-add" : ""))}<span className={"dvr-code" + (p.right.row.type === "add" ? " dvs-add" : "")}>{code(i, p.right.j, p.right.row)}</span></> : <><span className="dvr-num dvs-empty" /><span className="dvr-code dvs-empty" /></>}
                    </div>
                    {notes(key, anchor.row)}
                  </div>
                );
              })
              : h.rows.slice(0, shown).map((r, j) => {
                const key = `${i}:${j}`;
                return (
                  <div key={j}>
                    <div className={"dvr dvr-" + r.type}>
                      {gutter(key, r, r.num)}
                      <span className="dvr-code">{code(i, j, r)}</span>
                    </div>
                    {notes(key, r)}
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

// Inline review comment under a diff row: ⌘↵ sends, Esc cancels.
function CommentBox({ onSend, onCancel }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await onSend(text.trim());
    if (!ok) setBusy(false);
  };
  return (
    <div className="dv-cmt">
      <textarea
        autoFocus
        rows={2}
        value={text}
        placeholder="Feedback on this line — goes to the agent"
        aria-label="Comment"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
        }}
      />
      <div className="dv-cmt__actions">
        <span className="dv-cmt__hint">⌘↵ to send</span>
        <span className="sp-spacer" />
        <button type="button" className="dv-cmt__btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="dv-cmt__btn dv-cmt__btn--send" disabled={!text.trim() || busy} onClick={submit}>Send to agent</button>
      </div>
    </div>
  );
}
