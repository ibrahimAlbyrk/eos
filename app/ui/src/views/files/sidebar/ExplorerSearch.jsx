import { explorer, useSearchState, useSearchMode } from "../../../state/explorerStore.js";

export function ExplorerSearch() {
  const search = useSearchState();
  const mode = useSearchMode();
  const symbols = mode === "symbols";
  return (
    <div className="fx-search">
      <svg className="fx-search-ic" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" />
      </svg>
      <input
        className="fx-search-input"
        value={search.query}
        placeholder={symbols ? "Search symbols…" : "Search files…"}
        spellCheck={false}
        onChange={(e) => explorer.setSearchQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { explorer.setSearchQuery(""); e.currentTarget.blur(); } }}
      />
      <div className="fx-search-seg" role="tablist" aria-label="Search mode">
        <button className={"fx-seg-btn" + (symbols ? "" : " on")} onClick={() => explorer.setSearchMode("files")} title="Search filenames">Files</button>
        <button className={"fx-seg-btn" + (symbols ? " on" : "")} onClick={() => explorer.setSearchMode("symbols")} title="Search symbol names">Symbols</button>
      </div>
      {search.query && (
        <button className="fx-search-clear" onClick={() => explorer.setSearchQuery("")} title="Clear" aria-label="Clear search">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m4 4 8 8M12 4l-8 8" /></svg>
        </button>
      )}
    </div>
  );
}
