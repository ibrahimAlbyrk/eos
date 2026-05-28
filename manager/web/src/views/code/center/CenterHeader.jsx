import { useUi } from "../../../state/ui.jsx";
import { basename } from "../../../lib/path.js";

export function CenterHeader({ live }) {
  const ui = useUi();
  const selected = live.workers.find((w) => w.id === ui.selectedId) ?? null;

  const scope = basename(selected?.cwd ?? selected?.worktree_from ?? ui.composer.cwd ?? "") || "—";
  const cur = selected
    ? (selected.name || (selected.is_orchestrator ? "orchestrator" : "no-agent"))
    : "new orchestrator";

  return (
    <div className="head">
      <button className="head-toggle sb-iconbtn" onClick={() => ui.setSideCollapsed(false)} title="Show sidebar">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <line x1="6" y1="3" x2="6" y2="13" />
        </svg>
      </button>
      <div className="crumb">
        <span className="scope">{scope}</span>
        <span className="sep">/</span>
        <span className="cur">{cur}</span>
        <span className="v">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="m4 6 4 4 4-4" />
          </svg>
        </span>
      </div>
      <div className="right"></div>
    </div>
  );
}
