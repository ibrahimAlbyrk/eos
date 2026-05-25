import { useLayoutEffect, useRef } from "react";

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4.5V12a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3.5H3A1 1 0 002 4.5z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 2H4.5A1.5 1.5 0 003 3.5v9A1.5 1.5 0 004.5 14h7a1.5 1.5 0 001.5-1.5V6L9 2z" />
      <path d="M9 2v4h4" />
    </svg>
  );
}

function AgentIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="5" r="3" />
      <path d="M2.5 14a5.5 5.5 0 0111 0" />
    </svg>
  );
}

const STATE_COLORS = { WORKING: "var(--ok)", IDLE: "var(--fg-faint)", SPAWNING: "var(--warn)" };

function HighlightedName({ name, query }) {
  if (!query) return <span>{name}</span>;
  const idx = name.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <span>{name}</span>;
  return (
    <span>
      {name.slice(0, idx)}
      <b>{name.slice(idx, idx + query.length)}</b>
      {name.slice(idx + query.length)}
    </span>
  );
}

function entryKey(entry) {
  return entry.type === "agent" ? `agent:${entry.id}` : entry.absolutePath;
}

export function FileMenu({ entries, selectedIndex, onSelect, query }) {
  const listRef = useRef(null);

  useLayoutEffect(() => {
    if (!listRef.current) return;
    const active = listRef.current.querySelector(".file-item.active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!entries.length) return null;

  return (
    <div className="cmd-menu">
      <div className="cmd-names">
        <div className="cmd-names-inner" ref={listRef}>
          {entries.map((entry, i) => {
            if (entry.type === "agent") {
              return (
                <button
                  key={entryKey(entry)}
                  className={"file-item" + (i === selectedIndex ? " active" : "")}
                  onMouseDown={(e) => { e.preventDefault(); onSelect(entry); }}
                >
                  <span className="file-icon">
                    <AgentIcon />
                  </span>
                  <span className="file-name">
                    <HighlightedName name={entry.name} query={query} />
                  </span>
                  <span className="file-path" style={{ color: STATE_COLORS[entry.state] || "var(--fg-faint)" }}>
                    {(entry.state || "").toLowerCase()}
                  </span>
                </button>
              );
            }
            const parentDir = entry.relativePath?.includes("/")
              ? entry.relativePath.slice(0, entry.relativePath.lastIndexOf("/"))
              : "";
            return (
              <button
                key={entryKey(entry)}
                className={"file-item" + (i === selectedIndex ? " active" : "")}
                onMouseDown={(e) => { e.preventDefault(); onSelect(entry); }}
              >
                <span className="file-icon">
                  {entry.type === "directory" ? <FolderIcon /> : <FileIcon />}
                </span>
                <span className="file-name">
                  <HighlightedName name={entry.name} query={query} />
                </span>
                {parentDir && <span className="file-path">{parentDir}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
