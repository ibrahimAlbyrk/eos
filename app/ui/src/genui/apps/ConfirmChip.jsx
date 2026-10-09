import { useEffect, useState } from "react";

// What an app asked to say to the agent (or a link it asked to open), held
// until the user answers. Lives in the frame's chrome (outside the iframe, so
// the app can't draw over it), and Send/Open arms only after a beat — a chip
// that appears under a click already on its way can't be accepted by that click.

export const ARM_DELAY_MS = 500;
// Filled just after mount: a live region that arrives already holding its text
// is not reliably announced.
const ANNOUNCE_DELAY_MS = 60;

const SEND_ICON = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </svg>
);
const LINK_ICON = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
);

export function ConfirmChip({ text, kind = "send", onSend, onDismiss, onAlways, armDelay = ARM_DELAY_MS }) {
  const link = kind === "link";
  const lead = link ? "App wants to open:" : "App wants to send:";
  const [armed, setArmed] = useState(armDelay <= 0);
  const [said, setSaid] = useState("");
  useEffect(() => {
    if (armed) return undefined;
    const t = setTimeout(() => setArmed(true), armDelay);
    return () => clearTimeout(t);
  }, [armed, armDelay]);
  useEffect(() => {
    const t = setTimeout(() => setSaid(`${lead} ${String(text).slice(0, 300)}`), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(t);
  }, [lead, text]);

  return (
    <div className="gv-app-ask" role="group" aria-label={link ? "The app wants to open a link" : "The app wants to send a message"}>
      <span className="gv-app-sr" role="status" aria-live="polite" aria-atomic="true">{said}</span>
      <span className="gv-app-ask-lead">{link ? LINK_ICON : SEND_ICON}{lead}</span>
      <q className="gv-app-ask-text">{text}</q>
      <span className="gv-app-ask-actions">
        <button type="button" className="gv-app-btn gv-app-btn--primary" disabled={!armed} onClick={onSend}>{link ? "Open" : "Send"}</button>
        <button type="button" className="gv-app-btn" onClick={onDismiss}>Dismiss</button>
        <button type="button" className="gv-app-btn gv-app-btn--quiet" disabled={!armed} onClick={onAlways}>Always for this app</button>
      </span>
    </div>
  );
}
