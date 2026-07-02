// Floating ⌘F find bar — pinned to the top-right of the messages scroll area.
export function FindBar({ find }) {
  const onKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) find.prev(); else find.next();
    }
    if (e.key === "Escape") {
      e.stopPropagation();
      find.close();
    }
  };
  return (
    <div className="page-find-anchor">
      <div className="page-find">
        <input
          ref={find.inputRef}
          className="page-find-input"
          value={find.query}
          onChange={(e) => find.setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Find"
          spellCheck={false}
        />
        {find.query && (
          <span className="page-find-count">
            {find.matchCount > 0 ? `${find.idx + 1}/${find.matchCount}` : "0/0"}
          </span>
        )}
        <button className="fv-find-nav" onClick={find.prev} title="Previous match">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="m4 10 4-4 4 4" /></svg>
        </button>
        <button className="fv-find-nav" onClick={find.next} title="Next match">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="m4 6 4 4 4-4" /></svg>
        </button>
        <button className="fv-find-nav" onClick={find.close} title="Close">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="m4 4 8 8M12 4l-8 8" /></svg>
        </button>
      </div>
    </div>
  );
}
