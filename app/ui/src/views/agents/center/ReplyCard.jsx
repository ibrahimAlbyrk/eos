import { GlassLayers } from "../../../components/glass/GlassLayers.jsx";
import { ReplyWho } from "../messages/ReplyWho.jsx";

// The message being replied to: a glass capsule floating above the composer
// card until the reply is sent or dismissed (× or Esc).
export function ReplyCard({ target, agentName, onClose }) {
  return (
    <div className="reply-capsule">
      <GlassLayers />
      <svg className="reply-capsule-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 14 4 9l5-5" />
        <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
      </svg>
      <ReplyWho role={target.role} agentName={agentName} />
      <span className="reply-capsule-sep" aria-hidden="true" />
      <span className="reply-capsule-text">{target.text}</span>
      <button type="button" className="reply-capsule-close" onClick={onClose} title="Cancel reply (Esc)" aria-label="Cancel reply">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}
