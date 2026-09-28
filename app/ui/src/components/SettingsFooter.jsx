import { useEffect, useRef } from "react";
import { useSettings } from "../state/settings.jsx";
import { useUi } from "../state/ui.jsx";
import { AccountMenu } from "./AccountMenu.jsx";
import { useAccounts, ensureAccountsLoaded, accountTone, isSignedIn } from "../state/accountsStore.js";
import { ProviderGlyph } from "./accounts/ProviderGlyph.jsx";
import { metaFor } from "./accounts/providerMeta.js";

// The plans you're signed in to, at a glance: a tile each with its status dot
// (red once a sign-in expires).
function AccountGlyphs() {
  const { accounts } = useAccounts();
  useEffect(() => { ensureAccountsLoaded(); }, []);
  const signedIn = (accounts ?? []).filter(isSignedIn);
  if (!signedIn.length) return null;
  const label = signedIn.map((a) => `${metaFor(a).name}: ${a.route === "blocked" ? "sign-in expired" : "signed in"}`).join(", ");
  return (
    <span className="sb-settings__accounts" aria-label={label} title={label}>
      {signedIn.map((a) => <ProviderGlyph key={a.id} id={a.id} size={20} tone={accountTone(a)} />)}
    </span>
  );
}

// Bottom row of every view's sidebar: a profile row (avatar + name + connected
// providers) that opens the Account menu (accounts, plan usage, total cost,
// Settings) — the way into Settings besides ⌘,. The name is a placeholder until a
// profile source exists.
export function SettingsFooter({ live }) {
  const { openSettings } = useSettings();
  const ui = useUi();
  const ref = useRef(null);
  const open = ui.openPopover === "account-menu";

  const toggle = (e) => {
    e.stopPropagation();
    if (open) ui.closeAllPops();
    else ui.openPop("account-menu");
  };
  const openFromMenu = (sectionId) => {
    ui.closeAllPops();
    openSettings(sectionId);
  };

  const anchor = open ? ref.current?.getBoundingClientRect() : null;
  const totalCostUsd = (live?.workers ?? []).reduce((sum, w) => sum + (w.cost_usd ?? 0), 0);

  return (
    <div className="sb-settings" ref={ref}>
      <button
        className={"sb-settings__account" + (open ? " on" : "")}
        onClick={toggle}
        data-popover-trigger="account-menu"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="sb-settings__avatar" aria-hidden="true" />
        <span className="sb-settings__name">Account</span>
        <AccountGlyphs />
      </button>
      {anchor && <AccountMenu anchor={anchor} totalCostUsd={totalCostUsd} onOpenSettings={openFromMenu} />}
    </div>
  );
}
