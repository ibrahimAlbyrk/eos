import { useUi } from "../../state/ui.jsx";
import { relToRoot, kindGlyph } from "../../lib/symbols.js";

// Flat symbol-name search results (the Symbols search mode). Parallel to the
// filename search rows; each opens path+line in the pane's file editor panel.
export function SymbolSearchList({ search, root }) {
  const ui = useUi();
  const openPath = ui.fileViewer?.path ?? null;
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
          onClick={() => ui.openFileViewer(occ.path, { line: occ.line, column: occ.column })}
        >
          <span className="fx-ic fx-sym-kind" title={occ.kind}>{kindGlyph(occ.kind)}</span>
          <span className="fx-name">{occ.name}</span>
          <span className="fx-search-path">{relToRoot(occ.path, root)}:{occ.line}</span>
        </div>
      ))}
    </div>
  );
}
