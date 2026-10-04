import { useEffect, useRef } from "react";
import { useSettings } from "../state/settings.jsx";
import { useUi } from "../state/ui.jsx";
import { AccountMenu } from "./AccountMenu.jsx";
import { useAccounts, ensureAccountsLoaded, accountTone, isSignedIn } from "../state/accountsStore.js";
import { metaFor } from "./accounts/providerMeta.js";
import { MachineRow } from "./machines/MachineRow.jsx";
import { ProfileAvatar } from "./profile/ProfileAvatar.jsx";
import { useProfile, ensureProfileLoaded } from "../state/profileStore.js";
import { useUserMemories, ensureUserMemoriesLoaded, pendingMemories } from "../state/userMemoryStore.js";
import { useOpenMemory } from "../hooks/useOpenMemory.js";
import { openProfileInterview } from "../state/interviewStore.js";
import { openDreamReview } from "../state/dreamReviewStore.js";
import { isDreamProposal } from "../lib/dreamProposals.js";
import { displayName } from "../lib/profileText.js";

// The plans you're signed in to, for the avatar's tooltip, and whether any
// sign-in expired (the avatar then wears a red dot; the menu has the detail).
function useAccountSummary() {
  const { accounts } = useAccounts();
  useEffect(() => { ensureAccountsLoaded(); }, []);
  const signedIn = (accounts ?? []).filter(isSignedIn);
  const label = signedIn.map((a) => `${metaFor(a).name}: ${a.route === "blocked" ? "sign-in expired" : "signed in"}`).join(", ");
  return { label: label || "Account", expired: signedIn.some((a) => accountTone(a) === "expired") };
}

// Bottom row of every view's sidebar: the machine row, then the avatar that
// opens the Account menu (accounts, plan usage, total cost, Settings) — the way
// into Settings besides ⌘,.
export function SettingsFooter({ live }) {
  const { openSettings } = useSettings();
  const ui = useUi();
  const ref = useRef(null);
  const summary = useAccountSummary();
  const { profile } = useProfile();
  const pendingAll = pendingMemories(useUserMemories());
  const dreamt = pendingAll.filter(isDreamProposal).length;
  const pending = pendingAll.length - dreamt;
  const openMemory = useOpenMemory();
  useEffect(() => { ensureProfileLoaded(); ensureUserMemoriesLoaded(); }, []);
  const name = displayName(profile);
  const tooltip = [
    name,
    summary.label,
    dreamt ? `Dreamt · ${dreamt} to review` : null,
    pending ? `${pending} ${pending === 1 ? "memory" : "memories"} to review` : null,
  ].filter(Boolean).join(" — ");
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
      <MachineRow live={live} />
      <button
        className={"sb-settings__account" + (open ? " on" : "")}
        onClick={toggle}
        data-popover-trigger="account-menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account"
        title={tooltip}
      >
        <ProfileAvatar profile={profile} size={24} className="sb-settings__avatar" />
        {summary.expired
          ? <span className="sb-settings__alert" aria-hidden="true" />
          : dreamt > 0
            ? <span className="sb-settings__alert sb-settings__alert--dream" aria-hidden="true" />
            : pending > 0 && <span className="sb-settings__alert sb-settings__alert--pending" aria-hidden="true" />}
      </button>
      {anchor && (
        <AccountMenu
          anchor={anchor}
          totalCostUsd={totalCostUsd}
          pendingMemories={pending}
          dreamProposals={dreamt}
          onReviewDream={() => { ui.closeAllPops(); openDreamReview(); }}
          onOpenSettings={openFromMenu}
          onOpenMemory={openMemory}
          onSetUpProfile={() => { ui.closeAllPops(); openProfileInterview(); }}
        />
      )}
    </div>
  );
}
