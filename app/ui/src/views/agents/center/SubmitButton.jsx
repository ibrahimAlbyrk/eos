// Send / stop affordance for the composer. Presentational only: the composer
// owns the decision (which mode) and the wiring (what each click does); this
// just renders the matching icon and forwards the click.
const SendIcon = (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 13V4M4.5 7.5 8 4l3.5 3.5" />
  </svg>
);

const StopIcon = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" />
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
