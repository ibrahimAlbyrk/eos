import { useState } from "react";
import { useUi } from "../../state/ui.jsx";

export function SpawnPopover({ live }) {
  const ui = useUi();
  const [name, setName] = useState("");
  if (ui.openPopover !== "spawn") return null;

  // "Create" no longer touches the daemon — it creates a local draft and
  // selects it, so the user can pick folder/branch/worktree before sending
  // the first message. The daemon spawn happens on first Send.
  const create = () => {
    ui.createDraft(name.trim() || undefined);
    setName("");
    ui.closeAllPops();
  };

  return (
    <div className="spawn-popover spawn-popover--sidebar glass-pop open" id="spawnPopover" data-popover="spawn">
      <div className="sp-head">
        <span className="sp-title">New orchestrator</span>
        <button className="sp-close" onClick={ui.closeAllPops} title="Close">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      <div className="sp-body">
        <input
          className="sp-name-only"
          placeholder="orchestrator name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          onKeyDown={(e) => { if (e.key === "Enter") create(); }}
        />
        <span className="sp-hint">
          Pick folder, branch &amp; worktree above the composer before sending the first message.
        </span>
      </div>
      <div className="sp-foot">
        <button className="sp-btn primary" onClick={create}>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M8 3v10M3 8h10" />
          </svg>
          Create
        </button>
      </div>
    </div>
  );
}
