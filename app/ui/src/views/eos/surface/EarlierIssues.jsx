import { useState } from "react";
import { useMenuDismiss } from "../menu/useMenuDismiss.js";
import { loadEarlierIssues } from "../../../state/eos/pageStore.js";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { issueLabel, issueLine } from "./words.js";

const OLDER = "M10 3.5L5.5 8l4.5 4.5";
const NEWER = "M6 3.5L10.5 8 6 12.5";
const CHEVRON = "M4.5 6.5L8 10l3.5-3.5";

const glyph = (d, size = 14) => <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16"><path d={d} /></svg>;

// Which issue the sheet shows, at the right of the strip above it: the one
// before and the one after as arrows, and the issue itself, which opens the
// menu of every numbered issue, newest first. An issue opens in the design
// it was made with. With one issue only it is the issue's line.
export function EarlierIssues({ page, row }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useMenuDismiss(open, () => setOpen(false));
  if (!row) return null;
  const numbered = (page.issues ?? []).filter((i) => i.seq != null);
  if (numbered.length < 2 && !page.more) return <span className="eos-issues__line">{issueLine(row)}</span>;
  const at = numbered.findIndex((i) => i.id === row.id);
  const older = at >= 0 ? numbered[at + 1] : undefined;
  const newer = at > 0 ? numbered[at - 1] : undefined;
  const go = (issue) => {
    setOpen(false);
    openLocation(buildLocation({ screen: "surface", surfaceId: page.surface.id, issue: issue.seq }));
  };
  return (
    <span className="eos-issues eos-menu-wrap" ref={wrapRef}>
      <button type="button" className="eos-icon-btn eos-issues__step" aria-label="The issue before" disabled={!older} onClick={() => go(older)}>{glyph(OLDER)}</button>
      <button type="button" className="eos-issues__pick" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {issueLine(row)}
        {glyph(CHEVRON, 12)}
      </button>
      <button type="button" className="eos-icon-btn eos-issues__step" aria-label="The issue after" disabled={!newer} onClick={() => go(newer)}>{glyph(NEWER)}</button>
      {open && (
        <ul className="eos-menu eos-page__issues" role="menu" aria-label="Earlier issues" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
          {numbered.map((issue) => (
            <li key={issue.id} role="none">
              <button type="button" role="menuitem" className="eos-menu__item" aria-current={issue.id === row.id ? "true" : undefined} onClick={() => go(issue)}>
                {issueLabel(issue)}
              </button>
            </li>
          ))}
          {page.more && (
            <li role="none">
              <button type="button" role="menuitem" className="eos-menu__item eos-menu__item--more" onClick={() => void loadEarlierIssues(page.surface.id)}>
                Older issues
              </button>
            </li>
          )}
        </ul>
      )}
    </span>
  );
}
