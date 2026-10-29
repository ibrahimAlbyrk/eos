// Eos's eight-ray mark on its dark tile — the face of an update in the beacon's
// popover and Settings › Updates.
export function UpdateMark({ size = 22 }) {
  return (
    <span className="up-mark" aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24">
        <g stroke="var(--accent)" strokeWidth="2.1" strokeLinecap="round">
          <path d="M12 4.2v15.6M4.2 12h15.6M7.4 7.4l9.2 9.2M16.6 7.4l-9.2 9.2" />
        </g>
        <circle cx="12" cy="12" r="2" fill="#d6e6fb" />
      </svg>
    </span>
  );
}
