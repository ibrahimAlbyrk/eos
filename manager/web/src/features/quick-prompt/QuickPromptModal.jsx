// Blurred-backdrop modal: focused single-line textarea, Enter sends the
// prompt to the named agent without switching the main selection. Used by
// the right-click context menu's "Send prompt" action.

import { memo, useState, useEffect, useRef } from "react";
import { modelShort } from "../../lib/format.js";
import { Icon } from "../../components/primitives.jsx";

export const QuickPromptModal = memo(function QuickPromptModal({ open, agent, onClose, onSend }) {
  const ref = useRef(null);
  const dialogRef = useRef(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  // Native <dialog> handles Esc + focus trap + restore-on-close natively.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && agent && !d.open) d.showModal();
    if ((!open || !agent) && d.open) d.close();
  }, [open, agent]);

  useEffect(() => {
    if (open) {
      setText("");
      setSending(false);
      setTimeout(() => ref.current?.focus(), 30);
    }
  }, [open, agent?.id]);

  if (!open || !agent) return null;
  const submit = async () => {
    const v = text.trim();
    if (!v || sending) return;
    setSending(true);
    try { await onSend(v, agent.id); } finally { setSending(false); onClose(); }
  };
  return (
    <dialog
      ref={dialogRef}
      className="vb-qp-overlay"
      aria-label={`Send prompt to ${agent.name}`}
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => { if (e.target === dialogRef.current) onClose(); }}
    >
      <div className="vb-qp-shell" onClick={(e) => e.stopPropagation()}>
        <div className="vb-qp-target">
          <Icon name="arrowRight" size={12} />
          <span className={`vb-qp-target__name vb-turn__name--${agent.role}`}>{agent.name}</span>
          <span className="vb-qp-target__meta vb-mono">{modelShort(agent.model)}</span>
        </div>
        <textarea
          ref={ref}
          rows={3}
          placeholder={`Tell ${agent.name} what to do…`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
        />
        <div className="vb-qp-foot">
          <div className="vb-qp-hints">
            <span><kbd>⏎</kbd> send</span>
            <span><kbd>⇧⏎</kbd> newline</span>
            <span><kbd>Esc</kbd> cancel</span>
          </div>
          <button className="vb-btn vb-btn--primary" onClick={submit} disabled={!text.trim() || sending}>
            <span>{sending ? "Sending…" : "Send"}</span>
            <Icon name="send" size={12} />
          </button>
        </div>
      </div>
    </dialog>
  );
});
