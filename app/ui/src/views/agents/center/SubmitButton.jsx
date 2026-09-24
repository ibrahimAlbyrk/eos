// Send / stop affordance for the composer. Presentational only: the composer
// owns the decision (which mode) and the wiring (what each click does); this
// just renders the matching icon and forwards the click.
const SendIcon = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 13V4M4.5 7.5 8 4l3.5 3.5" />
  </svg>
);

const StopIcon = (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="1" width="14" height="14" rx="3" />
  </svg>
);

export function SubmitButton({ stop, dim, onClick }) {
  return (
    <button
      className={"submit" + (stop ? " stop" : "") + (dim ? " dim" : "")}
      title={stop ? "Stop (Esc)" : "Send"}
      onClick={onClick}
    >
      {stop ? StopIcon : SendIcon}
    </button>
  );
}
