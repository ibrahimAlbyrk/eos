// One subscription provider in Settings › Accounts. The card IS the sign-in
// surface: it moves through not connected / API key → signing in (browser) →
// connected (or expired) in place, and edits the API key inline. What it shows is
// the daemon's billing route for the account — the card never decides it.

import { useState } from "react";
import {
  useAccounts, isSignInActive, accountTone, startSignIn, cancelSignIn, signOut, removeApiKey,
} from "../../state/accountsStore.js";
import { ProviderGlyph } from "./ProviderGlyph.jsx";
import { SignInHelp } from "./SignInHelp.jsx";
import { ApiKeyField } from "./ApiKeyField.jsx";
import { metaFor, planName, keyHint } from "./providerMeta.js";
import { ExternalIcon, Spinner } from "./icons.jsx";

const STATUS_TEXT = { subscription: "Connected", api_key: "Using an API key", blocked: "Sign-in expired", none: "Not connected" };

// Top-right mark: a spinner while signing in, else the account's status dot.
function Status({ account, signing }) {
  const text = signing ? "Signing in" : STATUS_TEXT[account.route];
  return (
    <span className="acc-status" title={text} aria-label={text}>
      {signing ? <Spinner size={14} /> : <span className={`acc-dot is-${accountTone(account) ?? "off"}`} />}
    </span>
  );
}

// ① Subscription (active) → ② API key (standby): the order Eos bills in.
function BillingRoute({ account, onAddKey }) {
  return (
    <div className="acc-route">
      <div className="acc-route__row">
        <span className="acc-route__n is-on">1</span>
        <span className="acc-route__what">Subscription</span>
        <em className="is-on">Active</em>
      </div>
      <div className="acc-route__row">
        <span className="acc-route__n">2</span>
        <span className="acc-route__what mono">{account.apiKey.set ? keyHint(account) : "API key"}</span>
        {account.apiKey.set ? <em>Standby</em> : <button type="button" className="acc-link" onClick={onAddKey}>Add</button>}
      </div>
    </div>
  );
}

function Lead({ title, sub, mono = false, dim = false }) {
  return (
    <div className="acc-card__lead">
      <b className={dim ? "is-dim" : undefined}>{title}</b>
      {sub && <small className={mono ? "mono" : undefined}>{sub}</small>}
    </div>
  );
}

export function AccountCard({ account }) {
  const { signIns } = useAccounts();
  const [editingKey, setEditingKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const meta = metaFor(account);
  const sub = account.subscription;
  const session = signIns[account.id];
  const signing = isSignInActive(session);
  const canSignIn = Boolean(sub?.supported);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    const r = await fn();
    setBusy(false);
    if (r && !r.ok) setError(r.error);
  };
  const signIn = () => { setEditingKey(false); setError(null); startSignIn(account.id); };
  const removeKey = () => run(async () => {
    const r = await removeApiKey(account);
    if (r.ok) setEditingKey(false);
    return r;
  });

  const signInButton = (label = meta.signIn) => (
    <button type="button" className="acc-btn acc-btn--primary acc-btn--block" onClick={signIn} disabled={busy}>
      {label}<ExternalIcon size={13} />
    </button>
  );

  let body;
  let foot;
  if (signing) {
    body = (
      <>
        <Lead title="Finish in your browser" sub="Come back here when you're done." />
        <SignInHelp provider={account.id} session={session} />
      </>
    );
    foot = <button type="button" className="acc-btn acc-btn--quiet acc-btn--block" onClick={() => cancelSignIn(account.id)}>Cancel</button>;
  } else if (editingKey) {
    body = (
      <>
        <Lead
          title={account.apiKey.set ? "Replace the API key" : "Add an API key"}
          sub={sub?.state === "signed_in" ? "Used only while you're signed out" : "Billed per token by the provider"}
        />
        <ApiKeyField account={account} autoFocus onDone={() => setEditingKey(false)} onCancel={() => setEditingKey(false)} />
      </>
    );
    foot = account.apiKey.set
      ? <button type="button" className="acc-btn acc-btn--ghost acc-btn--danger" onClick={removeKey} disabled={busy}>Remove key</button>
      : null;
  } else if (account.route === "subscription") {
    body = (
      <>
        <Lead title={planName(sub.plan) ?? "Subscription"} sub="Signed in through Eos" />
        <BillingRoute account={account} onAddKey={() => setEditingKey(true)} />
      </>
    );
    foot = (
      <div className="acc-card__billing">
        <span className="is-ok">Subscription</span>
        <button type="button" className="acc-link" onClick={() => run(() => signOut(account.id))} disabled={busy}>Sign out</button>
      </div>
    );
  } else if (account.route === "blocked") {
    body = (
      <>
        <Lead title="Sign-in expired" sub={`${meta.name} agents wait until you sign in again`} />
        <p className="acc-card__text">
          {account.apiKey.set
            ? "Your API key stays unused until then — sign out to switch to it."
            : "Sign in again to keep using your plan."}
        </p>
      </>
    );
    foot = (
      <div className="acc-card__stack">
        {signInButton("Sign in again")}
        <button type="button" className="acc-btn acc-btn--ghost" onClick={() => run(() => signOut(account.id))} disabled={busy}>Sign out</button>
      </div>
    );
  } else if (account.route === "api_key") {
    body = (
      <>
        <Lead title="Pay per token" sub={keyHint(account)} mono />
        <p className="acc-card__text">
          {canSignIn
            ? `Sign in with ${meta.plans} to move ${meta.name} runs onto your plan. The key stays as a fallback.`
            : `Plan sign-in for ${meta.name} is coming soon — your key covers it until then.`}
        </p>
      </>
    );
    foot = (
      <div className="acc-card__stack">
        {canSignIn && signInButton()}
        <button type="button" className="acc-btn acc-btn--ghost" onClick={() => setEditingKey(true)}>Manage API key</button>
      </div>
    );
  } else {
    body = (
      <>
        <Lead title="Not connected" sub={canSignIn ? `${meta.plans}, or an API key` : "API key for now"} dim />
        <p className="acc-card__text">
          {canSignIn
            ? `Sign in with your ${meta.name} plan, or paste an API key to pay per token.`
            : `Paste an API key to use ${meta.name}. Plan sign-in is coming soon.`}
        </p>
      </>
    );
    foot = (
      <div className="acc-card__stack">
        {canSignIn
          ? signInButton()
          : <button type="button" className="acc-btn acc-btn--primary acc-btn--block" onClick={() => setEditingKey(true)}>Add API key</button>}
        {canSignIn
          ? <button type="button" className="acc-btn acc-btn--ghost" onClick={() => setEditingKey(true)}>Use an API key</button>
          : <span className="acc-soon">{meta.signIn} · Soon</span>}
      </div>
    );
  }

  const failed = !signing && session?.state === "failed" ? session.error : null;

  return (
    <article className={"acc-card" + (signing ? " is-signing" : "")} aria-label={`${meta.name} account`}>
      <header className="acc-card__head">
        <ProviderGlyph id={account.id} size={36} />
        <span className="acc-card__names">
          <b>{meta.name}</b>
          {meta.maker && <small>{meta.maker}</small>}
        </span>
        <Status account={account} signing={signing} />
      </header>
      {body}
      {(failed || error) && <div className="acc-err" role="alert">{failed || error}</div>}
      {foot && <footer className="acc-card__foot">{foot}</footer>}
    </article>
  );
}
