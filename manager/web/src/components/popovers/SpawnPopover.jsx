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
      <span className="sp-inline-title">New orchestrator</span>
      <div className="sp-inline">
        <input
          className="sp-name-only"
          placeholder="name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          onKeyDown={(e) => { if (e.key === "Enter") create(); }}
        />
        <button className="sp-btn primary" onClick={create}>Create</button>
      </div>
    </div>
  );
}
