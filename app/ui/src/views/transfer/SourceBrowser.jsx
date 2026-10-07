import { useCallback, useEffect, useState } from "react";
import { FileIcon } from "../files/FileIcon.jsx";
import { formatBytes } from "../../lib/format.js";
import { transfers } from "../../lib/transferClient.js";
import { BackIcon } from "./icons.jsx";

const nameOf = (p) => p.replace(/\/+$/, "").split("/").pop() || p;
const under = (path, dir) => path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

// One machine's folders: a few places to jump to, a breadcrumb, and a list to
// tick files and folders in. A folder opens on its name; ticking it takes all of
// it. Ticks survive moving between folders — `selected` is the caller's.
export function SourceBrowser({ machine, startPath, project, selected, onToggle }) {
  const [listing, setListing] = useState(null);
  const [error, setError] = useState(null);
  const [hidden, setHidden] = useState(false);

  const load = useCallback(async (path, withHidden) => {
    setError(null);
    try {
      setListing(await transfers.browse(machine, path, { hidden: withHidden }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [machine]);

  useEffect(() => {
    setListing(null);
    void load(startPath, false);
  }, [load, startPath]);

  const dir = listing?.path ?? null;
  const home = listing?.home ?? null;
  const places = [
    project && { label: nameOf(project), path: project },
    home && { label: "Desktop", path: `${home}/Desktop` },
    home && { label: "Downloads", path: `${home}/Downloads` },
    home && { label: "Home", path: home },
  ].filter(Boolean);
  const crumbs = crumbsOf(dir, home);
  const toggleHidden = () => { const next = !hidden; setHidden(next); if (dir) void load(dir, next); };

  return (
    <div className="tx-browser">
      <div className="tx-crumbs">
        <button type="button" className="tx-iconbtn" aria-label="Up one folder" disabled={!dir || !listing?.parent} onClick={() => void load(listing.parent, hidden)}>
          <BackIcon />
        </button>
        <span className="tx-crumbs__path">
          {crumbs.map((c, i) => (
            <span key={c.path} className="tx-crumb">
              {i > 0 && <span className="tx-crumb__sep">/</span>}
              {i === crumbs.length - 1
                ? <span className="tx-crumb__here">{c.label}</span>
                : <button type="button" className="tx-crumb__link" onClick={() => void load(c.path, hidden)}>{c.label}</button>}
            </span>
          ))}
        </span>
        <button type="button" className={"tx-iconbtn tx-iconbtn--text" + (hidden ? " on" : "")} aria-pressed={hidden} title="Show hidden files" onClick={toggleHidden}>.*</button>
      </div>

      {places.length > 0 && (
        <div className="tx-places">
          {places.map((p) => (
            <button key={p.path} type="button" className={"tx-chip" + (dir === p.path ? " on" : "")} onClick={() => void load(p.path, hidden)}>{p.label}</button>
          ))}
        </div>
      )}

      <div className="tx-list" role="group" aria-label="Files">
        {error && <div className="tx-list__note is-err">{error}</div>}
        {!error && !listing && <div className="tx-list__note">Loading…</div>}
        {!error && listing?.entries.length === 0 && <div className="tx-list__note">Empty folder</div>}
        {listing?.entries.map((e) => {
          const implied = [...selected.keys()].some((p) => p !== e.path && under(e.path, p));
          const on = implied || selected.has(e.path);
          const inside = e.type === "directory" && !on ? [...selected.keys()].filter((p) => under(p, e.path)).length : 0;
          const isDir = e.type === "directory";
          return (
            <div key={e.path} className={"tx-row" + (on ? " is-on" : "")}>
              <input
                type="checkbox"
                className="tx-check"
                aria-label={`Select ${e.name}`}
                checked={on}
                disabled={implied}
                title={implied ? "Included with its folder" : undefined}
                ref={(el) => { if (el) el.indeterminate = inside > 0; }}
                onChange={() => onToggle(e)}
              />
              <span className="tx-row__ic"><FileIcon type={e.type} name={e.name} /></span>
              {isDir
                ? <button type="button" className="tx-row__name tx-row__open" onClick={() => void load(e.path, hidden)}>{e.name}</button>
                : <span className="tx-row__name">{e.name}</span>}
              <span className="tx-row__meta">{inside > 0 ? `${inside} selected` : e.size != null ? formatBytes(e.size) : ""}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// "~ / Projects / neon-drift" — clickable, home-relative when the folder is under home.
function crumbsOf(dir, home) {
  if (!dir) return [];
  const atHome = home && (dir === home || under(dir, home));
  const base = atHome ? home : "/";
  const rest = dir === base ? [] : dir.slice(base === "/" ? 1 : base.length + 1).split("/");
  const crumbs = [{ label: atHome ? "~" : "/", path: base }];
  let acc = base === "/" ? "" : base;
  for (const seg of rest) {
    acc = `${acc}/${seg}`;
    crumbs.push({ label: seg, path: acc });
  }
  // The last few say where you are; earlier ones stay reachable through Up.
  return crumbs.length > 4 ? [crumbs[0], ...crumbs.slice(-3)] : crumbs;
}

