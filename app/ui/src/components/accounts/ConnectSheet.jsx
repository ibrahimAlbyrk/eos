// "Connect <provider>" — the just-in-time sheet the composer's provider picker
// opens for a provider that isn't connected. The same two ways in as its Settings
// card: sign in (browser) or paste an API key. It closes by itself once the
// account is usable and hands the account to `onConnected` (the picker selects it),
// so the user's typed task never leaves the composer.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useAccounts, isUsable, isSignInActive, startSignIn, cancelSignIn } from "../../state/accountsStore.js";
import { useConnectSheet, closeConnectSheet } from "../../state/connectSheetStore.js";
import { ProviderGlyph } from "./ProviderGlyph.jsx";
import { SignInHelp } from "./SignInHelp.jsx";
import { ApiKeyField } from "./ApiKeyField.jsx";
import { metaFor } from "./providerMeta.js";
import { CloseIcon, ExternalIcon, Spinner } from "./icons.jsx";

function Subscription({ account, session }) {
  const meta = metaFor(account);
  if (!account.subscription?.supported) {
    return (
      <div className="acc-sheet__box is-muted">
        <div className="acc-sheet__boxhead"><b>Subscription</b><span className="acc-soon">Soon</span></div>
        <p>Signing in with your {meta.name} plan is coming soon. An API key works today.</p>
      </div>
    );
  }
  if (isSignInActive(session)) {
    return (
      <div className="acc-sheet__box is-signing">
        <div className="acc-sheet__boxhead"><b>Finish in your browser</b><Spinner size={14} /></div>
        <p>Come back here when you're done — this closes by itself.</p>
        <SignInHelp provider={account.id} session={session} />
        <button type="button" className="acc-btn acc-btn--quiet acc-btn--block" onClick={() => cancelSignIn(account.id)}>Cancel</button>
      </div>
    );
  }
  return (
    <div className="acc-sheet__box">
      <div className="acc-sheet__boxhead"><b>Subscription</b><span className="acc-accent">Recommended</span></div>
      <p>Use your {meta.plans} plan. Always used while you're signed in.</p>
      {session?.state === "failed" && <div className="acc-err" role="alert">{session.error}</div>}
      <button type="button" className="acc-btn acc-btn--primary acc-btn--block" onClick={() => startSignIn(account.id)}>
        {account.route === "blocked" ? "Sign in again" : meta.signIn}<ExternalIcon size={13} />
      </button>
    </div>
  );
}

function ConnectSheet({ account, session, onConnected, ready }) {
  const meta = metaFor(account);
  const connected = useRef(false);

  useEffect(() => {
    if (connected.current || !(ready ?? isUsable)(account)) return;
    connected.current = true;
    closeConnectSheet();
    onConnected?.(account);
  }, [account, onConnected, ready]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeConnectSheet();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return createPortal(
    <div className="acc-sheet-overlay" onMouseDown={closeConnectSheet}>
      <div className="acc-sheet" role="dialog" aria-modal="true" aria-label={`Connect ${meta.name}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="acc-sheet__top">
          <ProviderGlyph id={account.id} size={46} />
          <button type="button" className="acc-icon-btn" aria-label="Close" onClick={closeConnectSheet}><CloseIcon size={15} /></button>
        </div>
        <div className="acc-sheet__intro">
          <h2>Connect {meta.name}</h2>
          <p>Choose how Eos pays for {meta.name}. Your task stays in the composer.</p>
        </div>
        <Subscription account={account} session={session} />
        <div className="acc-sheet__box is-outline">
          <div className="acc-sheet__boxhead"><b>API key</b></div>
          <ApiKeyField account={account} />
          <p className="acc-sheet__note">Metered, billed per token. Used only while you're not signed in.</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Mounted once at the app root; renders the sheet while one is open.
export function ConnectSheetHost() {
  const { provider, onConnected, ready } = useConnectSheet();
  const { accounts, signIns } = useAccounts();
  const account = provider ? accounts?.find((a) => a.id === provider) : null;
  if (!account) return null;
  return <ConnectSheet key={provider} account={account} session={signIns[provider]} onConnected={onConnected} ready={ready} />;
}
