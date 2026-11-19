import { useEffect, useState } from "react";
import { cancelSignIn, closeSignIn, openSignInPage, startSignIn, useSignIn } from "../../../state/eos/capabilitySignInStore.js";
import { DEV_RUN_TEXT } from "./parts.jsx";

// The phases that end the attempt: what the sheet says (a failure says the
// core's reason), and whether it offers another go.
const ENDED = {
  ready: { again: false },
  expired: { text: "The code ran out before it was entered.", again: "Get a new code" },
  denied: { text: "GitHub was told not to let Eos in.", again: "Try again" },
  cancelled: { text: "Sign-in cancelled.", again: "Start again" },
  client_id_missing: {
    text: "Eos has no GitHub client id, so it cannot start a sign-in. Set github.clientId in Eos's config, then try again.",
    again: false,
  },
  dev_run: { text: DEV_RUN_TEXT, again: false },
  failed: { again: "Try again" },
};

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

function Code({ attempt }) {
  return (
    <>
      <p className="eos-note">Eos opened GitHub in your browser. Enter this code there.</p>
      <p className="eos-code" aria-label="Your code">{attempt.userCode}</p>
      {attempt.phase === "pending" && <p className="eos-note" role="status">Waiting for GitHub…</p>}
      <div className="eos-actions">
        <button type="button" className="eos-btn eos-btn--primary" onClick={openSignInPage}>Open GitHub</button>
        <CopyCode code={attempt.userCode} />
        <button type="button" className="eos-btn" onClick={cancelSignIn}>Cancel</button>
      </div>
    </>
  );
}

function Ended({ attempt }) {
  const { text, again } = ENDED[attempt.phase];
  const done = attempt.phase === "ready";
  return (
    <>
      <p className="eos-note" role="status">
        {done ? (attempt.accountLabel ? `Signed in to GitHub as ${attempt.accountLabel}.` : "Signed in to GitHub.") : text ?? attempt.error}
      </p>
      <div className="eos-actions">
        {again && <button type="button" className="eos-btn eos-btn--primary" onClick={() => void startSignIn(attempt.id)}>{again}</button>}
        <button type="button" className={again ? "eos-btn" : "eos-btn eos-btn--primary"} onClick={closeSignIn}>{done ? "Done" : "Close"}</button>
      </div>
    </>
  );
}

// The GitHub sign-in sheet, over the Capabilities screens while an attempt is open.
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
  return (
    <div className="eos-sheet-overlay" onMouseDown={closeSignIn}>
      <div className="eos-sheet" role="dialog" aria-modal="true" aria-labelledby="eos-sign-in-title" onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="eos-sign-in-title" className="eos-sheet__title">Sign in to GitHub</h2>
        {attempt.phase === "starting" && <p className="eos-note" role="status">Asking GitHub for a code…</p>}
        {(attempt.phase === "code" || attempt.phase === "pending") && <Code attempt={attempt} />}
        {ENDED[attempt.phase] && <Ended attempt={attempt} />}
      </div>
    </div>
  );
}
