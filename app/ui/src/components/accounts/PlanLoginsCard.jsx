// A provider that holds several sign-ins (Claude) in Settings › Accounts: one row
// per sign-in, the default new sessions start on, and the API key. Each row shows
// the daemon's state for that sign-in — the card never decides it.

import { useState } from "react";
import {
  useAccounts, isSignInActive, startSignIn, cancelSignIn, removeLogin, renameLogin, setDefaultLogin, setAutoSwitch, removeApiKey,
} from "../../state/accountsStore.js";
import { SelectControl, ToggleControl } from "../../settings/controls.jsx";
import { useUsage } from "../../state/usageStore.js";
import { planUsageSections, isUsageWarn } from "../../lib/usageFormat.js";
import { ProviderGlyph } from "./ProviderGlyph.jsx";
import { SignInHelp } from "./SignInHelp.jsx";
import { ApiKeyField } from "./ApiKeyField.jsx";
import { metaFor, planLabel, keyHint } from "./providerMeta.js";
import { KeyIcon, PlusIcon, Spinner } from "./icons.jsx";

const AVATAR_TINTS = 4;

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// What a row says about its sign-in, when there is anything to say.
function loginState(login) {
  if (login.state === "expired") return { text: "Sign-in expired", warn: true };
  if (login.state !== "signed_in") return { text: "Signed out", warn: true };
  if (login.limitedUntil) return { text: `At limit · resets ${clock(login.limitedUntil)}`, warn: true };
  return null;
}

function RenameField({ label, onSave, onCancel }) {
  const [value, setValue] = useState(label);
  const save = () => {
    const next = value.trim();
    if (next && next !== label) onSave(next);
    else onCancel();
  };
  return (
    <input
      className="acc-input acc-login__rename"
      value={value}
      maxLength={60}
      aria-label="Account name"
      autoFocus
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape") onCancel();
      }}
    />
  );
}

// The sign-in's 5-hour window, when its usage is known.
function SessionUse({ row }) {
  const used = Math.round(row.window.utilization);
  return (
    <span className={"acc-login__use" + (isUsageWarn(row.window) ? " is-warn" : "")} title={`5-hour limit · ${used}% used`}>
      <span className="acc-login__bar" aria-hidden="true"><i style={{ width: `${Math.min(100, used)}%` }} /></span>
      <span>{used}% used</span>
    </span>
  );
}

function LoginRow({ provider, login, index, session, sessionRow, onResult }) {
  const [renaming, setRenaming] = useState(false);
  const renewing = isSignInActive(session) && session.loginId === login.id;
  const signedIn = login.state === "signed_in";
  const plan = planLabel(login.plan);
  const state = loginState(login);

  return (
    <li className={"acc-login" + (renewing ? " is-signing" : "") + (signedIn ? "" : " is-out")}>
      <span className={`acc-login__avatar is-tint-${index % AVATAR_TINTS}`} aria-hidden="true">
        {login.label.trim().charAt(0).toUpperCase()}
      </span>
      <span className="acc-login__names">
        {renaming ? (
          <RenameField
            label={login.label}
            onCancel={() => setRenaming(false)}
            onSave={async (label) => { setRenaming(false); onResult(await renameLogin(provider, login.id, label)); }}
          />
        ) : (
          <b>{login.label}{plan && <span className="acc-login__plan">{plan}</span>}</b>
        )}
        {login.email && login.email !== login.label && <small>{login.email}</small>}
      </span>
      {renewing ? (
        <span className="acc-login__state"><Spinner size={13} />Signing in</span>
      ) : state ? (
        <span className={"acc-login__state" + (state.warn ? " is-warn" : "")}>{state.text}</span>
      ) : sessionRow ? (
        <SessionUse row={sessionRow} />
      ) : (
        <span />
      )}
      {login.inUse ? <span className="acc-login__inuse">In use{login.inUse > 1 ? ` · ${login.inUse}` : ""}</span> : <span />}
      <span className="acc-login__actions">
        {!signedIn && !renewing && (
          <button type="button" className="acc-link" onClick={() => startSignIn(provider, login.id)}>Sign in again</button>
        )}
        <button type="button" className="acc-link acc-link--quiet" onClick={() => setRenaming(true)}>Rename</button>
        <button type="button" className="acc-link acc-link--quiet" onClick={async () => onResult(await removeLogin(provider, login.id))}>
          Sign out
        </button>
      </span>
      {renewing && (
        <div className="acc-login__help">
          <SignInHelp provider={provider} session={session} onCancel={() => cancelSignIn(provider)} />
        </div>
      )}
    </li>
  );
}

function ApiKeyRow({ account, onResult }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <div className="acc-logins__key is-editing">
        <ApiKeyField account={account} autoFocus onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />
        {account.apiKey.set && (
          <button
            type="button"
            className="acc-btn acc-btn--ghost acc-btn--danger"
            onClick={async () => {
              const r = await removeApiKey(account);
              if (r.ok) setEditing(false);
              onResult(r);
            }}
          >
            Remove key
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="acc-logins__key">
      <span className="acc-logins__key-icon" aria-hidden="true"><KeyIcon size={15} /></span>
      <span className="acc-logins__text">
        <b>API key {account.apiKey.set && <span className="mono">{keyHint(account)}</span>}</b>
        <small>Used only while you're signed out</small>
      </span>
      <button type="button" className="acc-link acc-link--quiet" onClick={() => setEditing(true)}>
        {account.apiKey.set ? "Edit" : "Add"}
      </button>
    </div>
  );
}

export function PlanLoginsCard({ account }) {
  const { signIns } = useAccounts();
  const { usage, now } = useUsage();
  const sessionRowOf = (loginId) =>
    planUsageSections(usage, now).find((s) => s.loginId === loginId)?.rows.find((r) => r.kind === "session") ?? null;
  const [error, setError] = useState(null);
  const meta = metaFor(account);
  const logins = account.logins;
  const session = signIns[account.id];
  const signing = isSignInActive(session);
  const adding = signing && !session.loginId;
  const failed = !signing && session?.state === "failed" ? session.error : null;
  const onResult = (r) => setError(r && !r.ok ? r.error : null);

  return (
    <article className="acc-card acc-logins" aria-label={`${meta.name} accounts`}>
      <header className="acc-card__head">
        <ProviderGlyph id={account.id} size={36} />
        <span className="acc-card__names">
          <b>{meta.name}</b>
          <small>{logins.length === 1 ? "1 account" : `${logins.length} accounts`}</small>
        </span>
        <button type="button" className="acc-btn acc-btn--quiet" onClick={() => { setError(null); startSignIn(account.id); }} disabled={signing}>
          <PlusIcon size={13} />Add account
        </button>
      </header>

      <ul className="acc-logins__list">
        {logins.map((login, i) => (
          <LoginRow key={login.id} provider={account.id} login={login} index={i} session={session} sessionRow={sessionRowOf(login.id)} onResult={onResult} />
        ))}
        {adding && (
          <li className="acc-login is-signing">
            <span className="acc-login__avatar" aria-hidden="true"><Spinner size={13} /></span>
            <span className="acc-login__names">
              <b>Finish in your browser</b>
              <small>Sign in with the account you want to add.</small>
            </span>
            <div className="acc-login__help">
              <SignInHelp provider={account.id} session={session} onCancel={() => cancelSignIn(account.id)} />
            </div>
          </li>
        )}
      </ul>

      {logins.length > 1 && (
        <>
          <div className="acc-logins__setting">
            <span className="acc-logins__text">
              <b>Default account</b>
              <small>New sessions start here.</small>
            </span>
            <SelectControl
              value={account.defaultLoginId}
              options={logins.map((l) => ({ value: l.id, label: l.label }))}
              onChange={async (id) => onResult(await setDefaultLogin(account.id, id))}
            />
          </div>
          <div className="acc-logins__setting">
            <span className="acc-logins__text">
              <b>Switch automatically when one runs out</b>
              <small>The session moves to another account and keeps its context.</small>
            </span>
            <ToggleControl
              value={account.autoSwitch !== false}
              onChange={async (on) => onResult(await setAutoSwitch(account.id, on))}
            />
          </div>
        </>
      )}

      <ApiKeyRow account={account} onResult={onResult} />
      {(failed || error) && <div className="acc-err" role="alert">{failed || error}</div>}
    </article>
  );
}
