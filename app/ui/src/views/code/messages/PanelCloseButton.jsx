// The one canonical × for a docked panel's chrome. Every viewer rendered its own
// byte-identical close button before; they now share this. className keeps each
// viewer's existing hook (fv-icon-btn fv-close for the file-row viewers, av-close
// for the agent viewer) so the surrounding header layout is untouched.
export function PanelCloseButton({ onClose, className = "fv-icon-btn fv-close" }) {
  return (
    <button className={className} onClick={onClose} title="Close">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="m4 4 8 8M12 4l-8 8" />
      </svg>
    </button>
  );
}
