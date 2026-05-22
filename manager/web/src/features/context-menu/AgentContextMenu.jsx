// Right-click menu — positioned where the cursor was, closes on outside-
// click or Escape. Two actions: send a quick prompt (opens the
// QuickPromptModal) or kill the worker.

import { memo, useEffect, useRef } from "react";
import { Icon } from "../../components/primitives.jsx";

export const AgentContextMenu = memo(function AgentContextMenu({ menu, onClose, onQuickPrompt, onKill }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!menu) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [menu, onClose]);
  if (!menu) return null;
  // Clamp position so the menu stays fully on-screen.
  const W = 200, H = 120;
  const x = Math.min(menu.x, window.innerWidth - W - 8);
  const y = Math.min(menu.y, window.innerHeight - H - 8);
  return (
    <div ref={ref} className="vb-ctxmenu" style={{ left: x, top: y }}>
      <button className="vb-ctxmenu__item" onClick={() => { onQuickPrompt(menu.agentId); onClose(); }}>
        <Icon name="send" size={12} /> <span>Send prompt</span>
      </button>
      <div className="vb-ctxmenu__sep" />
      <button className="vb-ctxmenu__item vb-ctxmenu__item--danger" onClick={() => { onKill(menu.agentId); onClose(); }}>
        <Icon name="kill" size={12} /> <span>Kill</span>
      </button>
    </div>
  );
});
