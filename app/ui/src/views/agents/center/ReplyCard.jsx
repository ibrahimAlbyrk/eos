// The message being replied to, shown at the top of the composer card until the
// reply is sent or dismissed (× or Esc).
export function ReplyCard({ target, onClose }) {
  const when = target.ts != null
    ? new Date(target.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : null;
  return (
    <div className="reply-card">
      <div className="reply-card-head">
        {when && <span className="reply-card-time">{when}</span>}
        <button type="button" className="reply-card-close" onClick={onClose} title="Cancel reply (Esc)" aria-label="Cancel reply">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      <div className={`reply-card-quote ${target.role === "user" ? "is-user" : ""}`}>{target.text}</div>
    </div>
  );
}
