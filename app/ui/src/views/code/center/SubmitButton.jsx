// Send / stop affordance for the composer. Presentational only: the composer
// owns the decision (which mode) and the wiring (what each click does); this
// just renders the matching icon and forwards the click.
const SendIcon = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 4v5H4m3-3l-3 3 3 3" />
  </svg>
);

const StopIcon = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" />
  </svg>
);

export function SubmitButton({ stop, onClick }) {
  return (
    <button
      className={stop ? "submit stop" : "submit"}
      title={stop ? "Stop (Esc)" : "Send"}
      onClick={onClick}
    >
      {stop ? StopIcon : SendIcon}
    </button>
  );
}
