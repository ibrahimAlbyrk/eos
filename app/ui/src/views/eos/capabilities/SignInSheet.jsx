import { useEffect, useState } from "react";
import { cancelSignIn, closeSignIn, openSignInPage, serviceName, startSignIn, useSignIn } from "../../../state/eos/capabilitySignInStore.js";
import { Dialog, Fact, Stations } from "../frame.jsx";
import { DEV_RUN_TEXT } from "./parts.jsx";

const KEY_ICON = "M10 6.2a3.2 3.2 0 1 1-6.4 0 3.2 3.2 0 0 1 6.4 0zM9.2 8.6l4.3 4.4M11.6 11.1l1.3-1.3";

// The phases that end the attempt: what the sheet says for `name`'s
// attempt (a failure says the core's reason), whether it offers another go,
// and the tone the station it stopped at is lit in.
const ENDED = {
  ready: () => ({ again: false, tone: "ok" }),
  expired: (name, browser) => ({
    text: browser ? `${name} did not send you back in time.` : "The code ran out before it was entered.",
    again: browser ? "Connect again" : "Get a new code",
    tone: "warn",
  }),
  denied: (name) => ({ text: `${name} was told not to let Eos in.`, again: "Try again", tone: "err" }),
  cancelled: () => ({ text: "Sign-in cancelled.", again: "Start again" }),
  client_id_missing: (name, _browser, id) => ({
    text: `Eos has no ${name} client id, so it cannot start a sign-in. Set ${id}.clientId in Eos's config, then try again.`,
    again: false,
    tone: "warn",
  }),
  dev_run: () => ({ text: DEV_RUN_TEXT, again: false }),
  failed: () => ({ again: "Try again", tone: "err" }),
};

// The way through the service, as stations: GitHub gives a code the user
// enters on its page; Slack's page asks the user to allow Eos.
const WAYS = {
  code: { names: ["Code", "On GitHub", "Signed in"] },
  browser: { names: ["Opened", "Allow", "Connected"] },
};

function CopyCode({ code }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return <button type="button" className="eos-btn eos-btn--quiet" onClick={copy}>{copied ? "Copied" : "Copy code"}</button>;
}

function doneLine(attempt, name) {
  const label = attempt.accountLabel;
  if (attempt.id === "slack") return label ? `Connected to ${label}.` : `Connected to ${name}.`;
  return label ? `Signed in to ${name} as ${label}.` : `Signed in to ${name}.`;
}

// What the dialog asks or says in each phase: its title, its line, where the
// way stands, the status under it and the actions.
function view(attempt, name, browser) {
  const { phase } = attempt;
  const waiting = phase === "pending";
  if (phase === "starting") {
    return {
      title: browser ? `Opening ${name}…` : `Asking ${name} for a code…`,
      at: 0, tone: "active", working: true, words: ["Asking", "", ""],
      acts: [["Cancel", closeSignIn, "quiet"]],
    };
  }
  if (phase === "code" || (waiting && attempt.userCode)) {
    return {
      title: `Enter this code on ${name}`,
      line: `Eos opened ${name} in your browser. Type the code there and press Continue.`,
      code: attempt.userCode,
      at: 1, tone: "active", working: true, words: ["", waiting ? `Waiting for ${name}` : "Enter it there", ""],
      status: waiting ? `Waiting for ${name}…` : null, statusTone: "active",
      acts: [["Cancel", cancelSignIn, "quiet"], [`Open ${name}`, openSignInPage, "primary"]],
    };
  }
  if (phase === "browser" || waiting) {
    return {
      title: `Allow Eos on ${name}`,
      line: `Eos opened ${name} in your browser. Pick your workspace and press Allow; ${name} sends you back here.`,
      quiet: "You never type or paste a password or a key.",
      at: 1, tone: "active", working: true, words: ["", "Press Allow there", ""],
      // Slack sends the user back by itself: the sheet waits from the start.
      status: `Waiting for ${name}…`, statusTone: "active",
      acts: [["Cancel", cancelSignIn, "quiet"], [`Open ${name} again`, openSignInPage, "primary"]],
    };
  }
  const ended = ENDED[phase]?.(name, Boolean(attempt.verificationUri) && !attempt.userCode, attempt.id);
  if (!ended) return null;
  const done = phase === "ready";
  // The way is drawn only when the attempt reached the service.
  const reached = done || ((phase === "expired" || phase === "denied" || phase === "failed") && Boolean(attempt.verificationUri));
  return {
    title: done ? doneLine(attempt, name).replace(/\.$/, "") : `The sign-in to ${name} did not finish`,
    at: done ? 2 : 1, tone: ended.tone, words: done ? ["", "", "Done"] : ["", "Stopped here", ""],
    stations: reached,
    status: done ? doneLine(attempt, name) : ended.text ?? attempt.error,
    statusTone: done ? "ok" : ended.tone,
    acts: [
      [done ? "Done" : "Close", closeSignIn, ended.again ? "quiet" : "primary"],
      ...(ended.again ? [[ended.again, () => void startSignIn(attempt.id), "primary"]] : []),
    ],
  };
}

// The sign-in dialog, over the Capabilities screens while an attempt is
// open: a code to type for GitHub, Allow in the browser for Slack, and the
// way through the service drawn as stations.
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
  const v = view(attempt, name, browser);
  if (!v) return null;
  const way = WAYS[browser ? "browser" : "code"];
  return (
    <Dialog
      id="eos-sign-in"
      from={browser ? `Connect ${name}` : `Sign in to ${name}`}
      icon={KEY_ICON}
      title={v.title}
      line={v.line}
      onClose={closeSignIn}
      wide
      actions={v.acts.map(([label, run, kind]) => (
        <button key={label} type="button" className={`eos-btn eos-btn--${kind}`} onClick={run}>{label}</button>
      ))}
    >
      <div className="eos-sign-in">
        {v.code && (
          <div className="eos-code-well">
            <p className="eos-code" aria-label="Your code">{v.code}</p>
            <CopyCode code={v.code} />
          </div>
        )}
        {v.quiet && <p className="eos-sign-in__quiet">{v.quiet}</p>}
        {v.stations !== false && <Stations names={way.names} at={v.at} tone={v.tone ?? "active"} words={v.words} working={v.working} inset />}
        {v.status && <Fact tone={v.statusTone} role="status">{v.status}</Fact>}
      </div>
    </Dialog>
  );
}
