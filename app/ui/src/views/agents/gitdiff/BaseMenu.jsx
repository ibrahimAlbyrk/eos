import { useEffect, useMemo, useState } from "react";
import { api } from "../../../api/client.js";
import { AnchoredMenu } from "./AnchoredMenu.jsx";
import { BranchGlyph, CheckGlyph, SearchGlyph } from "./glyphs.jsx";

// Pick the ref the branch scope compares against: "Default" (the repo's own
// base — origin/HEAD, else main/master) or any remote / local branch.
export function BaseMenu({ anchorRef, cwd, base, resolvedBase, onBase, onClose }) {
  const [refs, setRefs] = useState(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    api.listBranches(cwd, { remotes: true }).then((r) => {
      if (cancelled) return;
      const local = (r.branches ?? []).filter((b) => b !== r.current);
      const remote = (r.remoteBranches ?? []).filter((b) => !b.endsWith("/HEAD"));
      setRefs([...remote, ...local]);
    }).catch(() => { if (!cancelled) setRefs([]); });
    return () => { cancelled = true; };
  }, [cwd]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (refs ?? []).filter((r) => !q || r.toLowerCase().includes(q)).slice(0, 60);
  }, [refs, filter]);
  const pick = (ref) => { onBase(ref); onClose(); };

  return (
    <AnchoredMenu anchorRef={anchorRef} onClose={onClose} width={280} className="cx-base-menu">
      <label className="cx-menu__filter">
        <SearchGlyph />
        <input autoFocus value={filter} placeholder="Compare against…" aria-label="Filter branches" spellCheck={false} onChange={(e) => setFilter(e.target.value)} />
      </label>
      <button type="button" role="menuitemradio" aria-checked={!base} className="cx-menu__item" onClick={() => pick(null)}>
        <BranchGlyph />
        <span className="cx-menu__text"><span>Default</span><span className="cx-menu__sub">{resolvedBase ?? "origin/HEAD, main or master"}</span></span>
        {!base && <CheckGlyph />}
      </button>
      <div className="cx-menu__sep" />
      <div className="cx-menu__scroll">
        {refs === null && <div className="cx-menu__note">Loading…</div>}
        {refs !== null && shown.length === 0 && <div className="cx-menu__note">No matching branches</div>}
        {shown.map((ref) => (
          <button key={ref} type="button" role="menuitemradio" aria-checked={base === ref} className={"cx-menu__item cx-mono" + (base === ref ? " on" : "")} onClick={() => pick(ref)}>
            <span className="cx-menu__ellip">{ref}</span>
            {base === ref && <CheckGlyph />}
          </button>
        ))}
      </div>
    </AnchoredMenu>
  );
}
