// The one canonical × for a docked panel's chrome, rendered by PanelShell's
// header for every panel type.
export function PanelCloseButton({ onClose }) {
  return (
    <button className="fv-icon-btn fv-close" onClick={onClose} title="Close">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="m4 4 8 8M12 4l-8 8" />
      </svg>
    </button>
  );
}
