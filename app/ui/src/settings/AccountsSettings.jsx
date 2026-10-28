// Settings › Accounts — every provider in one place: the subscription providers
// as cards (sign in here, or fall back to an API key), a provider holding several
// sign-ins as a list of them, and the API-key-only providers as tiles. Replaces the old Model (providers) and Anthropic
// (credentials) sections.
//
// Custom Component (no registry `groups`) — it owns no settings.json keys; the
// accounts live in config.json + the Keychain behind /api/accounts.

import { useEffect, useState } from "react";
import { useAccounts, refreshAccounts, getAccountsState } from "../state/accountsStore.js";
import { AccountCard } from "../components/accounts/AccountCard.jsx";
import { PlanLoginsCard } from "../components/accounts/PlanLoginsCard.jsx";
import { ApiKeyProviders } from "../components/accounts/ApiKeyProviders.jsx";
import { RuleLegend } from "../components/accounts/RuleLegend.jsx";

export function AccountsSettings() {
  const { accounts } = useAccounts();
  const [failed, setFailed] = useState(false);

  const load = () => {
    setFailed(false);
    refreshAccounts().then(() => { if (!getAccountsState().accounts) setFailed(true); });
  };
  useEffect(load, []);

  const featured = (accounts ?? []).filter((a) => a.subscription);
  // Signed in at least once: the list of sign-ins; until then the card signs in.
  const listed = featured.filter((a) => a.logins?.length);
  const cards = featured.filter((a) => !a.logins?.length);
  const keyOnly = (accounts ?? []).filter((a) => !a.subscription);

  return (
    <div className="acc-settings">
      <header className="acc-head">
        <div className="acc-head__text">
          <h2 className="stg-title">Accounts</h2>
          <p>Sign in to as many plans as you like — new sessions start on your default. API keys cover the rest.</p>
        </div>
        <RuleLegend />
      </header>
      {accounts ? (
        <>
          {listed.map((a) => <PlanLoginsCard key={a.id} account={a} />)}
          {cards.length > 0 && (
            <div className="acc-cards">
              {cards.map((a) => <AccountCard key={a.id} account={a} />)}
            </div>
          )}
          {keyOnly.length > 0 && <ApiKeyProviders accounts={keyOnly} />}
        </>
      ) : failed ? (
        <div className="stg-empty">
          Couldn't load your accounts. <button type="button" className="acc-link" onClick={load}>Retry</button>
        </div>
      ) : (
        <div className="stg-empty">Loading accounts…</div>
      )}
    </div>
  );
}
