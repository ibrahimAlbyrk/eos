import { useState } from "react";
import { useMenuDismiss } from "../menu/useMenuDismiss.js";
import { loadEarlierIssues } from "../../../state/eos/pageStore.js";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { issueLabel } from "./words.js";

// "Earlier issues": a menu of the page's numbered issues, newest first; one
// opens in the design it was made with.
export function EarlierIssues({ page, row }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useMenuDismiss(open, () => setOpen(false));
  const numbered = (page.issues ?? []).filter((i) => i.seq != null);
  if (numbered.length < 2 && !page.more) return null;
  const pick = (issue) => {
    setOpen(false);
    openLocation(buildLocation({ screen: "surface", surfaceId: page.surface.id, issue: issue.seq }));
  };
  return (
    <span className="eos-menu-wrap" ref={wrapRef}>
      <button type="button" className="eos-btn eos-btn--quiet" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Earlier issues
      </button>
      {open && (
        <ul className="eos-menu eos-page__issues" role="menu" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
          {numbered.map((issue) => (
            <li key={issue.id} role="none">
              <button type="button" role="menuitem" className="eos-menu__item" aria-current={issue.id === row?.id ? "true" : undefined} onClick={() => pick(issue)}>
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
