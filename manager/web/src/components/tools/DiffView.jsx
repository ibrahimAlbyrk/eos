import { memo, useMemo, useState } from "react";
import { diffLinesUnified } from "../../lib/diff.js";
import { Icon } from "../primitives.jsx";

// Renders one hunk of a unified diff. Word-level segments on individual
// rows let us dim the unchanged portions of a modified line so only the
// real edit pops in accent color.
function HunkRow({ row }) {
  const sign = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
  return (
    <div className={`vb-diff__row vb-diff__row--${row.kind}`}>
      <span className="vb-diff__num vb-diff__num--old">{row.oldNo ?? ""}</span>
      <span className="vb-diff__num vb-diff__num--new">{row.newNo ?? ""}</span>
      <span className="vb-diff__sign">{sign}</span>
      <span className="vb-diff__text">
        {row.segments
          ? row.segments.map((s, i) =>
              s.kind === "change"
                ? <mark key={i} className={`vb-diff__chg vb-diff__chg--${row.kind}`}>{s.text}</mark>
                : <span key={i}>{s.text}</span>)
          : row.text}
      </span>
    </div>
  );
}

export const DiffView = memo(function DiffView({ oldStr, newStr, language, label, contextRadius = 3 }) {
  const diff = useMemo(() => diffLinesUnified(oldStr, newStr, { contextRadius }), [oldStr, newStr, contextRadius]);
  const [expanded, setExpanded] = useState(false);
  // Above ~80 rows we collapse to the hunk view; user can expand to see the
  // full file context if they need it. Below that, just show the hunks
  // directly — the whole thing fits on one screen.
  const totalRows = diff.rows.length;
  const showFull = expanded || totalRows <= 80;
  const blocks = showFull ? [diff.rows] : diff.hunks;

  if (totalRows === 0) {
    return <div className="vb-diff vb-diff--empty">no textual change</div>;
  }

  return (
    <div className={`vb-diff ${language ? `vb-diff--lang-${language}` : ""}`}>
      {label && (
        <div className="vb-diff__label">
          <span>{label}</span>
          <span className="vb-diff__stats">
            <span className="vb-diff__stat vb-diff__stat--del">−{diff.stats.del}</span>
            <span className="vb-diff__stat vb-diff__stat--add">+{diff.stats.add}</span>
          </span>
        </div>
      )}
      {blocks.map((hunk, hi) => (
        <div key={hi} className="vb-diff__hunk">
          {hi > 0 && (
            <div className="vb-diff__sep">
              <span className="vb-diff__sep-dots">⋯</span>
            </div>
          )}
          {hunk.map((row, i) => <HunkRow key={i} row={row} />)}
        </div>
      ))}
      {!showFull && totalRows > 80 && (
        <button className="vb-diff__expand" onClick={() => setExpanded(true)}>
          <Icon name="chevronDown" size={11} /> show full context ({totalRows} lines)
        </button>
      )}
    </div>
  );
});
