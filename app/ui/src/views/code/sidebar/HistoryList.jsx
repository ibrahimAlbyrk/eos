import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { subscribe, getHistory, forgetSession, clearHistory } from "../../../state/codeHistoryStore.js";
import { resumeSession } from "../../../state/codeWorkspaceStore.js";
import { groupColorHex } from "../../../lib/groupColors.js";
import { useDismiss } from "../../../hooks/useDismiss.js";
import { paneTitle } from "../TermGrid.jsx";
import { historyBuckets } from "./historyBuckets.js";
import { KindGlyph, CloseGlyph, MoreGlyph, ChevronGlyph, SearchGlyph } from "../icons.jsx";

// Older buckets start folded so the recent ones stay in reach.
const FOLDED_AT_START = ["week", "older"];

// The Code sidebar's closed sessions, by day. A click reopens one in the focused
// pane (or a split beside it): Claude Code resumes its conversation, a shell
// starts again in its folder. × forgets one; the search icon filters by title
// or folder; ••• clears the history.
export function HistoryList() {
  const entries = useSyncExternalStore(subscribe, getHistory);
  const [folded, setFolded] = useState(() => new Set(FOLDED_AT_START));
  const [query, setQuery] = useState(null); // null: filter closed
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  if (!entries.length) return null;

  const buckets = historyBuckets(entries, Date.now(), query ?? "");
  const toggle = (key) => setFolded((prev) => {
    const next = new Set(prev);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  return (
    <div className="cw-hist">
      <div className="sb-seclabel">
        <span className="sb-seclabel__text">History</span>
        <span className="cw-count">{entries.length}</span>
        <span className="cw-seclabel__acts">
          <button
            className={"sb-iconbtn" + (query != null ? " on" : "")}
            title="Filter history"
            aria-label="Filter history"
            aria-pressed={query != null}
            onClick={() => setQuery(query == null ? "" : null)}
          >
            <SearchGlyph />
          </button>
          <button
            className={"sb-iconbtn" + (menuOpen ? " on" : "")}
            title="History options"
            aria-label="History options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <MoreGlyph />
          </button>
        </span>
        {menuOpen && <HistoryMenu onClose={closeMenu} />}
      </div>
      {query != null && (
        <input
          className="cw-hist-search"
          aria-label="Filter history by title or folder"
          placeholder="Title or folder"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") setQuery(null); }}
        />
      )}
      <div className="cw-list">
        {buckets.map((b) => {
          const open = Boolean(query) || !folded.has(b.key);
          return (
            <div key={b.key} className="cw-hist-day">
              <button
                className={"cw-hist-day__head" + (open ? "" : " is-folded")}
                aria-expanded={open}
                onClick={() => toggle(b.key)}
              >
                <span className="cw-hist-day__chev"><ChevronGlyph /></span>
                <span>{b.label}</span>
                <span className="cw-count">{b.items.length}</span>
              </button>
              {open && b.items.map((item) => <HistoryRow key={item.entry.id} item={item} />)}
            </div>
          );
        })}
        {buckets.length === 0 && <div className="cw-hist-empty">No matches</div>}
      </div>
    </div>
  );
}

// The dot is the color of the group the session was closed in.
function HistoryRow({ item }) {
  const { entry, folder, time, ran } = item;
  const reopen = () => resumeSession(entry);
  return (
    <div
      className="cw-row cw-row--hist"
      role="button"
      tabIndex={0}
      onClick={reopen}
      onKeyDown={(e) => { if (e.key === "Enter") reopen(); }}
      title={entry.cwd}
    >
      <span className="cw-row__ic"><KindGlyph kind={entry.kind} size={14} /></span>
      <span className="cw-row__text">
        <span className="cw-row__name">{paneTitle(entry)}</span>
        <span className="cw-row__sub" style={{ "--cw-group": groupColorHex(entry.color) }}>
          <span className="cw-row__dot" />
          <span className="cw-row__folder">{folder}</span>
          {ran && <span>· {ran}</span>}
        </span>
      </span>
      <span className="cw-row__meta">{time}</span>
      <button
        className="cw-row__act"
        title="Remove from history"
        aria-label="Remove from history"
        onClick={(e) => { e.stopPropagation(); forgetSession(entry.id); }}
      >
        <CloseGlyph />
      </button>
    </div>
  );
}

function HistoryMenu({ onClose }) {
  const ref = useRef(null);
  useDismiss(ref, onClose);
  return (
    <div className="cw-menu cw-hist-menu" ref={ref} role="menu">
      <button
        className="cw-menu__item cw-menu__item--action"
        role="menuitem"
        onClick={() => { clearHistory(); onClose(); }}
      >
        <span className="cw-menu__name">Clear history</span>
      </button>
    </div>
  );
}
