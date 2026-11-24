import { useEffect, useState } from "react";
import { cancelSignIn, closeSignIn, openSignInPage, serviceName, startSignIn, useSignIn } from "../../../state/eos/capabilitySignInStore.js";
import { DEV_RUN_TEXT } from "./parts.jsx";

// The phases that end the attempt: what the sheet says for `name`'s
// attempt (a failure says the core's reason), and whether it offers another go.
const ENDED = {
  ready: () => ({ again: false }),
  expired: (name, browser) => ({
    text: browser ? `${name} did not send you back in time.` : "The code ran out before it was entered.",
    again: browser ? "Connect again" : "Get a new code",
  }),
  denied: (name) => ({ text: `${name} was told not to let Eos in.`, again: "Try again" }),
  cancelled: () => ({ text: "Sign-in cancelled.", again: "Start again" }),
  client_id_missing: (name, _browser, id) => ({
    text: `Eos has no ${name} client id, so it cannot start a sign-in. Set ${id}.clientId in Eos's config, then try again.`,
    again: false,
  }),
  dev_run: () => ({ text: DEV_RUN_TEXT, again: false }),
  failed: () => ({ again: "Try again" }),
};

// Slack's way: allow Eos on Slack's own page, and Slack sends you back.
function Browser({ name }) {
  return (
    <>
      <p className="eos-note">Eos opened {name} in your browser. Pick your workspace and press Allow; {name} sends you back here.</p>
      <p className="eos-note eos-sign-in__quiet">You never type or paste a password or a key.</p>
      <p className="eos-note" role="status">Waiting for {name}…</p>
      <div className="eos-actions">
        <button type="button" className="eos-btn eos-btn--primary" onClick={openSignInPage}>Open {name} again</button>
        <button type="button" className="eos-btn" onClick={cancelSignIn}>Cancel</button>
      </div>
    </>
  );
}

function CopyCode({ code }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return <button type="button" className="eos-btn" onClick={copy}>{copied ? "Copied" : "Copy code"}</button>;
}

function Code({ attempt, name }) {
  return (
    <>
      <p className="eos-note">Eos opened {name} in your browser. Enter this code there.</p>
      <p className="eos-code" aria-label="Your code">{attempt.userCode}</p>
      {attempt.phase === "pending" && <p className="eos-note" role="status">Waiting for {name}…</p>}
      <div className="eos-actions">
        <button type="button" className="eos-btn eos-btn--primary" onClick={openSignInPage}>Open {name}</button>
        <CopyCode code={attempt.userCode} />
        <button type="button" className="eos-btn" onClick={cancelSignIn}>Cancel</button>
      </div>
    </>
  );
}

function doneLine(attempt, name) {
  const label = attempt.accountLabel;
  if (attempt.id === "slack") return label ? `Connected to ${label}.` : `Connected to ${name}.`;
  return label ? `Signed in to ${name} as ${label}.` : `Signed in to ${name}.`;
}

function Ended({ attempt, name }) {
  const { text, again } = ENDED[attempt.phase](name, Boolean(attempt.verificationUri) && !attempt.userCode, attempt.id);
  const done = attempt.phase === "ready";
  return (
    <>
      <p className="eos-note" role="status">{done ? doneLine(attempt, name) : text ?? attempt.error}</p>
      <div className="eos-actions">
        {again && <button type="button" className="eos-btn eos-btn--primary" onClick={() => void startSignIn(attempt.id)}>{again}</button>}
        <button type="button" className={again ? "eos-btn" : "eos-btn eos-btn--primary"} onClick={closeSignIn}>{done ? "Done" : "Close"}</button>
      </div>
    </>
  );
}

// The sign-in sheet, over the Capabilities screens while an attempt is open:
// a code to type for GitHub, Allow in the browser for Slack.
export function SignInSheet() {
  const attempt = useSignIn();
  const open = attempt !== null;

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeSignIn();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;
  const name = serviceName(attempt.id);
  const browser = attempt.id === "slack";
  return (
    <div className="eos-sheet-overlay" onMouseDown={closeSignIn}>
      <div className="eos-sheet" role="dialog" aria-modal="true" aria-labelledby="eos-sign-in-title" onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="eos-sign-in-title" className="eos-sheet__title">{browser ? `Connect ${name}` : `Sign in to ${name}`}</h2>
        {attempt.phase === "starting" && (
          <p className="eos-note" role="status">{browser ? `Opening ${name}…` : `Asking ${name} for a code…`}</p>
        )}
        {(attempt.phase === "code" || (attempt.phase === "pending" && attempt.userCode)) && <Code attempt={attempt} name={name} />}
        {(attempt.phase === "browser" || (attempt.phase === "pending" && !attempt.userCode)) && <Browser name={name} />}
        {ENDED[attempt.phase] && <Ended attempt={attempt} name={name} />}
      </div>
    </div>
  );
}
