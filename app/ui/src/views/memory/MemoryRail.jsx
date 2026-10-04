import { useEffect, useState } from "react";
import { api } from "../../api/client.js";
import { DreamingRow } from "../../components/profile/DreamingRow.jsx";

// The side column: how much of the prompt the always-on memories take (the real
// rendered block, via the profile preview) and what's coming.
export function MemoryRail({ rev, onOpenProfile }) {
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    let alive = true;
    api.getProfilePreview().then((p) => { if (alive) setPreview(p); }).catch(() => {});
    return () => { alive = false; };
  }, [rev]);

  const pct = preview ? Math.min(100, Math.round((preview.tokens / preview.budgetTokens) * 100)) : 0;

  return (
    <aside className="mem-rail">
      <section className="mem-card">
        <span className="mem-card__title">Prompt budget</span>
        <span className="mem-meter"><span className="mem-meter__fill" style={{ width: `${pct}%` }} /></span>
        <span className="mem-card__row">
          <span><b className="mono">{preview?.tokens ?? "—"}</b> of {preview?.budgetTokens ?? "—"} tokens</span>
          <button type="button" className="prof-link-btn" onClick={onOpenProfile}>Adjust</button>
        </span>
        <p className="mem-card__desc">
          Always-on memories ride every new agent's prompt
          {preview?.overflow ? ` — ${preview.overflow} didn't fit and wait to be looked up.` : "."} The rest stay on demand.
        </p>
      </section>
      <section className="mem-card">
        <span className="mem-card__title">Learning</span>
        <DreamingRow compact />
      </section>
    </aside>
  );
}
