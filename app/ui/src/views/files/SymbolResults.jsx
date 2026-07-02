import { explorer } from "../../state/explorerStore.js";
import { groupByFile, relToRoot, kindGlyph } from "../../lib/symbols.js";

// Honest labeling: this tier is name-matched (syntactic), so results can include
// false positives across same-named symbols. Say so, plainly.
const NAME_MATCH_HINT = "Name matches — may include unrelated same-named symbols.";

// References / go-to-def picker panel. Replaces the tree while open; occurrences
// grouped by file, each row reveals path+line. Styled like the search results.
export function RefsPanel({ refs, root, openPath }) {
  const { name, want, occurrences, loading, indexing } = refs;
  const groups = groupByFile(occurrences);
  const heading = want === "definitions" ? "Definitions of" : "References to";

  return (
    <div className="fx-tree" role="tree">
      <div className="fx-sym-head">
        <span className="fx-sym-head-title">
          {heading} <b>{name}</b>
          {!loading && !indexing && <span className="fx-sym-count">{occurrences.length}</span>}
        </span>
        <button className="fx-search-clear" onClick={() => explorer.closeRefs()} title="Close" aria-label="Close panel">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m4 4 8 8M12 4l-8 8" /></svg>
        </button>
      </div>
      {indexing ? (
        <div className="fx-empty fx-empty--sm">Indexing…</div>
      ) : loading ? (
        <div className="fx-empty fx-empty--sm">Searching…</div>
      ) : occurrences.length === 0 ? (
        <div className="fx-empty fx-empty--sm">No name matches</div>
      ) : (
        <>
          <div className="fx-sym-hint">{NAME_MATCH_HINT}</div>
          {groups.map((g) => (
            <div key={g.path} className="fx-sym-group">
              <div className="fx-sym-file" title={g.path}>{relToRoot(g.path, root)}</div>
              {g.items.map((occ, i) => (
                <div
                  key={`${occ.line}:${occ.column}:${i}`}
                  className={"fx-row fx-sym-row" + (occ.path === openPath ? " on" : "")}
                  onClick={() => explorer.openAt(occ.path, occ.line, occ.column)}
                >
                  <span className="fx-sym-line">{occ.line}</span>
                  <span className="fx-sym-text">{occ.lineText?.trim() || occ.name}</span>
                  {occ.role === "definition" && <span className="fx-sym-badge">def</span>}
                </div>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// Flat symbol-name search results (the Symbols search mode). Parallel to the
// filename search rows; each opens path+line.
export function SymbolSearchList({ search, root, openPath }) {
  const results = search.results ?? [];
  if (results.length === 0) {
    const msg = search.loading ? "Searching…" : search.unavailable ? "Symbol index unavailable" : "No symbols";
    return <div className="fx-tree"><div className="fx-empty fx-empty--sm">{msg}</div></div>;
  }
  return (
    <div className="fx-tree" role="tree">
      {results.map((occ, i) => (
        <div
          key={`${occ.path}:${occ.line}:${occ.column}:${i}`}
          className={"fx-row fx-search-row" + (occ.path === openPath ? " on" : "")}
          onClick={() => explorer.openAt(occ.path, occ.line, occ.column)}
        >
          <span className="fx-ic fx-sym-kind" title={occ.kind}>{kindGlyph(occ.kind)}</span>
          <span className="fx-name">{occ.name}</span>
          <span className="fx-search-path">{relToRoot(occ.path, root)}:{occ.line}</span>
        </div>
      ))}
    </div>
  );
}
