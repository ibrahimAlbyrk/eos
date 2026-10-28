// Where a session moved to another Claude sign-in mid-turn (account_switched):
// the sign-in it continued on, and why the one before stopped.

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function accountSwitchReason(block) {
  if (block.reason === "reset") return "its limit reset";
  if (block.reason === "api_key") return "billed per token";
  if (block.reason === "expired") return `${block.from} needs to sign in again`;
  return block.resetsAt ? `${block.from} resets ${clock(block.resetsAt)}` : `${block.from} reached its limit`;
}

export function AccountSwitchLine({ block }) {
  return (
    <div className="account-switch-line mono" title={block.from ? `${block.from} → ${block.to}` : block.to}>
      <span className="account-switch-line__text">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 5.5h9.5L10 3M13 10.5H3.5L6 13" />
        </svg>
        <span>Continued on <b>{block.to}</b> · {accountSwitchReason(block)}</span>
      </span>
    </div>
  );
}
