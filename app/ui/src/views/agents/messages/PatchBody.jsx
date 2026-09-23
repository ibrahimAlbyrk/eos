import { useEffect, useMemo, useRef, useState } from "react";
import { parsePatch } from "../../../lib/patch.js";
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

export function PatchBody({ file, patch }) {
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
