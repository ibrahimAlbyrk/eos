import { useUi } from "../../state/ui.jsx";

export function AgentContextMenu({ live }) {
  const ui = useUi();
  if (ui.openPopover !== "ctx-menu") return null;
  const { x, y } = ui.popoverPos;
  const { agentId, name, model } = ui.popoverData;

  const sendPrompt = () => {
    ui.openPop("quick-prompt", { data: { agentId, name, model } });
  };

  const rename = () => {
    ui.setRenamingId(agentId);
    ui.closeAllPops();
  };

  const kill = async () => {
    if (!agentId) return;
    // Drafts are local-only — no daemon call.
    if (ui.drafts.has(agentId)) {
      if (ui.selectedId === agentId) ui.setSelectedId(null);
      ui.removeDraft(agentId);
      ui.closeAllPops();
      return;
    }
    // Clear selection *before* the DELETE returns so any in-flight diff /
    // events fetch for this agent doesn't race with the row removal.
    if (ui.selectedId === agentId) ui.setSelectedId(null);
    ui.closeAllPops();
    try {
      const r = await live.killAgent(agentId);
      if (!r?.ok) {
        const msg = r?.body?.error ?? `status ${r?.status ?? "?"}`;
        // eslint-disable-next-line no-console
        console.error("kill failed:", msg);
        alert(`Kill failed: ${msg}`);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("kill threw:", e);
      alert(`Kill threw: ${(e instanceof Error) ? e.message : String(e)}`);
    }
  };

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
      <button className="menu-item" onClick={sendPrompt}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 8h9M9 4l4 4-4 4" />
        </svg>
        Send prompt
        <span className="kbd">⌘P</span>
      </button>
      <button className="menu-item" onClick={rename}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M11.5 1.5l3 3L5 14H2v-3z" />
        </svg>
        Rename
      </button>
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
