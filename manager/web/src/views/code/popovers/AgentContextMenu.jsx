import { useUi } from "../../../state/ui.jsx";
import { useDeleteAgent } from "../../../hooks/useDeleteAgent.js";

export function AgentContextMenu({ live }) {
  const ui = useUi();
  const deleteAgent = useDeleteAgent(live);
  if (ui.openPopover !== "ctx-menu") return null;
  const { x, y } = ui.popoverPos;
  const { agentId } = ui.popoverData;
  const agent = live.workers?.find((w) => w.id === agentId);
  const resumable = !!agent && (agent.state === "SUSPENDED" || agent.state === "DONE") && !!agent.session_id;

  const rename = () => {
    ui.setRenamingId(agentId);
    ui.closeAllPops();
  };

  const resume = async () => {
    ui.closeAllPops();
    try {
      const r = await live.resumeAgent(agentId);
      if (!r?.ok) {
        // eslint-disable-next-line no-console
        console.error("resume failed:", r?.body?.error ?? `status ${r?.status ?? "?"}`);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("resume threw:", e);
    }
  };

  // Direct kill, no confirm (user choice) — the eos/trash tombstone tag keeps
  // unmerged branch commits recoverable, and dirty worktrees are preserved.
  // Selection re-targeting + the pre-DELETE selection switch live in
  // useDeleteAgent (shared with the Cmd+W hotkey).
  const kill = () => deleteAgent(agentId);

  // Clamp to viewport
  const left = Math.min(x, window.innerWidth - 220);
  const top = Math.min(y, window.innerHeight - 145);

  return (
    <div
      className="ctx-menu glass-pop open"
      id="agentCtxMenu"
      data-popover="ctx-menu"
      style={{ display: "block", left, top }}
    >
      <button className="menu-item" onClick={rename}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M11.5 1.5l3 3L5 14H2v-3z" />
        </svg>
        Rename
      </button>
      {resumable && (
        <button className="menu-item" onClick={resume}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 2.5l9 5.5-9 5.5z" />
          </svg>
          Resume
        </button>
      )}
      <div className="menu-sep"></div>
      <button className="menu-item danger" onClick={kill}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="8" cy="8" r="6" /><path d="M5 5l6 6M11 5l-6 6" />
        </svg>
        Kill agent
      </button>
    </div>
  );
}
