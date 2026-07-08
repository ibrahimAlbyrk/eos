import { groupByFile, relToRoot } from "../../../lib/symbols.js";

// References drawer for the File panel: the honest name-matched occurrence list a
// CodeLens chip (or right-click → find refs) opens. Presentation only — the pure
// grouping/path helpers are shared with the Files-view panel; navigation and
// close are callbacks so this stays decoupled from any store.
const NAME_MATCH_HINT = "Name matches — may include unrelated same-named symbols.";

export function SymbolRefsPanel({ refs, root, currentPath, onOpen, onClose }) {
  const { name, occurrences, loading } = refs;
  const groups = groupByFile(occurrences);
  return (
    <div className="fv-symrefs">
      <div className="fv-symrefs-head">
        <span className="fv-symrefs-title">
          References to <b>{name}</b>
          {!loading && <span className="fv-symrefs-count">{occurrences.length}</span>}
        </span>
        <button className="fv-icon-btn" onClick={onClose} title="Close">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="m4 4 8 8M12 4l-8 8" /></svg>
        </button>
      </div>
      {loading ? (
        <div className="fv-symrefs-empty">Searching…</div>
      ) : occurrences.length === 0 ? (
        <div className="fv-symrefs-empty">No name matches</div>
      ) : (
        <div className="fv-symrefs-body">
          <div className="fv-symrefs-hint">{NAME_MATCH_HINT}</div>
          {groups.map((g) => (
            <div key={g.path} className="fv-symrefs-group">
              <div className="fv-symrefs-file" title={g.path}>{relToRoot(g.path, root)}</div>
              {g.items.map((occ, i) => (
                <div
                  key={`${occ.line}:${occ.column}:${i}`}
                  className={"fv-symrefs-row" + (occ.path === currentPath ? " on" : "")}
                  onClick={() => onOpen(occ)}
                >
                  <span className="fv-symrefs-line">{occ.line}</span>
                  <span className="fv-symrefs-text">{occ.lineText?.trim() || occ.name}</span>
                  {occ.role === "definition" && <span className="fv-symrefs-badge">def</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
