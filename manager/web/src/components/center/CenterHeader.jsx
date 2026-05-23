import { useUi } from "../../state/ui.jsx";
import { basename } from "../../lib/path.js";

export function CenterHeader({ live }) {
  const ui = useUi();
  const draft = ui.drafts.get(ui.selectedId);
  const selected = !draft ? live.workers.find((w) => w.id === ui.selectedId) : null;

  const scope = basename(selected?.cwd ?? selected?.worktree_from ?? draft?.cwd ?? "") || "—";
  const cur = draft
    ? (draft.name?.trim() || "new orchestrator")
    : (selected?.name || (selected?.is_orchestrator ? "orchestrator" : "no-agent"));

  return (
    <div className="head">
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
