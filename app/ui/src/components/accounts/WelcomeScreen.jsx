// First-run welcome — a full-window sign-in shown when no provider is connected
// at all (App.jsx decides). Left: what Eos does with a sign-in and the billing
// rule. Right: one row per subscription provider that walks through its own
// sign-in in place (browser → connected), or takes an API key where plan sign-in
// isn't available yet. Continue opens the workspace; Skip remembers the choice.

import { useState } from "react";
import { useAccounts, isUsable, isSignInActive, startSignIn, cancelSignIn } from "../../state/accountsStore.js";
import { ProviderGlyph } from "./ProviderGlyph.jsx";
import { SignInHelp } from "./SignInHelp.jsx";
import { ApiKeyField } from "./ApiKeyField.jsx";
import { RuleLegend } from "./RuleLegend.jsx";
import { metaFor, planName } from "./providerMeta.js";
import { ArrowIcon, CheckIcon, ExternalIcon, KeyIcon, Spinner } from "./icons.jsx";

function RowText({ title, sub }) {
  return (
    <span className="acc-wrow__text">
      <b>{title}</b>
      {sub && <small>{sub}</small>}
    </span>
  );
}

function WelcomeRow({ account, session }) {
  const [addingKey, setAddingKey] = useState(false);
  const meta = metaFor(account);
  const sub = account.subscription;

  if (isUsable(account)) {
    return (
      <div className="acc-wrow is-done">
        <ProviderGlyph id={account.id} size={32} />
        <RowText
          title={meta.name}
          sub={account.route === "subscription" ? (planName(sub?.plan) ?? "Subscription") : "API key"}
        />
        <span className="acc-wrow__check" aria-label="Connected"><CheckIcon size={13} /></span>
      </div>
    );
  }

  if (isSignInActive(session)) {
    return (
      <div className="acc-wrow is-waiting">
        <div className="acc-wrow__main">
          <ProviderGlyph id={account.id} size={32} />
          <RowText title="Waiting for your browser…" sub={`Finish signing in to ${meta.name}`} />
          <Spinner size={18} />
        </div>
        <SignInHelp provider={account.id} session={session} onCancel={() => cancelSignIn(account.id)} />
      </div>
    );
  }

  if (!sub?.supported) {
    return (
      <div className={"acc-wrow" + (addingKey ? " is-open" : "")}>
        <button type="button" className="acc-wrow__main" onClick={() => setAddingKey((v) => !v)} aria-expanded={addingKey}>
          <ProviderGlyph id={account.id} size={32} />
          <RowText title={`Add a ${meta.name} API key`} sub="Plan sign-in coming soon" />
          <KeyIcon size={15} />
        </button>
        {addingKey && <div className="acc-wrow__extra"><ApiKeyField account={account} autoFocus onCancel={() => setAddingKey(false)} /></div>}
      </div>
    );
  }

  const failed = session?.state === "failed" ? session.error : null;
  return (
    <div className="acc-wrow">
      <button type="button" className="acc-wrow__main" onClick={() => startSignIn(account.id)}>
        <ProviderGlyph id={account.id} size={32} />
        <RowText
          title={account.route === "blocked" ? `Sign in to ${meta.name} again` : meta.cta}
          sub={account.route === "blocked" ? "Your sign-in expired" : meta.plans}
        />
        <ExternalIcon size={15} />
      </button>
      {failed && <div className="acc-wrow__extra"><div className="acc-err" role="alert">{failed}</div></div>}
    </div>
  );
}

export function WelcomeScreen({ onContinue, onSkip, onUseKeys }) {
  const { accounts, signIns } = useAccounts();
  const featured = (accounts ?? []).filter((a) => a.subscription);
  const ready = (accounts ?? []).some(isUsable);

  return (
    <div className="acc-welcome" role="dialog" aria-modal="true" aria-label="Welcome to Eos">
      <div className="acc-welcome__drag" aria-hidden="true" />
      <section className="acc-welcome__story">
        <div className="acc-welcome__brand"><span className="acc-welcome__mark" />eos</div>
        <div className="acc-welcome__pitch">
          <div className="acc-eyebrow">Welcome</div>
          <h1>Bring the plans<br />you already pay for.</h1>
          <p>
            Sign in to Claude, ChatGPT or Google and every agent Eos runs uses that subscription.
            No sign-in? Eos falls back to an API key.
          </p>
        </div>
        <RuleLegend detailed />
      </section>

      <section className="acc-welcome__panel">
        <div className="acc-welcome__form">
          <div className="acc-welcome__intro">
            <h2>Sign in</h2>
            <p>Connect one or more. Each finishes in your browser.</p>
          </div>
          <div className="acc-welcome__list">
            {featured.map((a) => <WelcomeRow key={a.id} account={a} session={signIns[a.id]} />)}
          </div>
          <div className="acc-or"><span />or<span /></div>
          <button type="button" className="acc-btn acc-btn--outline acc-btn--tall" onClick={onUseKeys}>
            <KeyIcon size={15} />Use API keys instead
          </button>
          <div className="acc-welcome__foot">
            <button type="button" className="acc-link acc-link--quiet" onClick={onSkip}>Skip for now</button>
            <button type="button" className="acc-btn acc-btn--primary acc-btn--tall" disabled={!ready} onClick={onContinue}>
              Continue<ArrowIcon size={15} />
            </button>
          </div>
          <p className="acc-welcome__hint">Change this anytime in Settings › Accounts.</p>
        </div>
      </section>
    </div>
  );
}
