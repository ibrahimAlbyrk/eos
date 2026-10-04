import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client.js";
import { fmtCost } from "../lib/format.js";
import {
  WARN_THRESHOLD, USAGE_PROVIDER_ACCOUNTS, formatResetIn, formatResetInShort, formatResetAt, planUsageSections,
} from "../lib/usageFormat.js";
import { useAccounts, refreshAccounts, accountTone, isSignedIn } from "../state/accountsStore.js";
import { ProviderGlyph } from "./accounts/ProviderGlyph.jsx";
import { metaFor, planName } from "./accounts/providerMeta.js";
import { GeneralIcon } from "../settings/registry.jsx";
import { useProfile } from "../state/profileStore.js";
import { ProfileMenuHeader, MemoryReviewRow, DreamReviewRow, MemoryIcon } from "./profile/ProfileMenuHeader.jsx";

const RING_R = 18;
const RING_C = 2 * Math.PI * RING_R;

function UsageRing({ pct }) {
  const filled = Math.min(100, Math.max(0, pct));
  return (
    <span className="acct-ring">
      <svg viewBox="0 0 42 42" aria-hidden="true">
        <circle className="acct-ring__track" cx="21" cy="21" r={RING_R} />
        <circle
          className="acct-ring__fill"
          cx="21"
          cy="21"
          r={RING_R}
          strokeDasharray={RING_C}
          strokeDashoffset={RING_C * (1 - filled / 100)}
          transform="rotate(-90 21 21)"
        />
      </svg>
      <span className="acct-ring__pct">{pct}<span className="acct-ring__unit">%</span></span>
    </span>
  );
}

// The ring shows what's left of the limit (it drains as you use it). Session
// limits count down ("in 2h 15m"), weekly ones name the moment; the tooltip
// carries the long label + reset.
function UsageStat({ row }) {
  const used = Math.round(row.window.utilization);
  const left = Math.max(0, 100 - used);
  const { resetsAt } = row.window;
  const session = row.kind === "session";
  const reset = session ? `in ${formatResetInShort(resetsAt)}` : formatResetAt(resetsAt);
  const full = session ? `Resets in ${formatResetIn(resetsAt)}` : `Resets ${formatResetAt(resetsAt)}`;
  return (
    <div className={"acct-stat" + (used >= WARN_THRESHOLD ? " is-warn" : "")} title={`${row.label} · ${left}% left · ${full}`}>
      <UsageRing pct={left} />
      <span className="acct-stat__text">
        <span className="acct-stat__label">{row.short}</span>
        <span className="acct-stat__reset">{reset}</span>
      </span>
    </div>
  );
}

function planLabel(account, section) {
  if (account.route === "blocked") return "Expired";
  return section?.plan ?? planName(account.subscription?.plan)?.replace(/ plan$/, "") ?? "Subscription";
}

// A card per plan you're signed in to (an expired one included — it needs
// attention) with a ring per limit from GET /api/usage. A plan with no usage to
// show (loading, failed, or a provider that reports none) keeps just its header —
// the menu is a glance surface, not an error one.
export function PlanCards({ accounts, usage }) {
  const sections = planUsageSections(usage);
  return (accounts ?? []).filter(isSignedIn).map((a) => {
    const section = sections.find((s) => USAGE_PROVIDER_ACCOUNTS[s.provider] === a.id);
    return (
      <div className="acct-card" key={a.id}>
        <div className="acct-card__head">
          <ProviderGlyph id={a.id} size={24} tone={accountTone(a)} />
          <span className="acct-card__name">{metaFor(a).name}</span>
          <span className={"acct-plan" + (a.route === "blocked" ? " is-expired" : "")}>{planLabel(a, section)}</span>
        </div>
        {section && (
          <div className="acct-card__stats">
            {section.rows.map((r) => <UsageStat key={r.key} row={r} />)}
          </div>
        )}
      </div>
    );
  });
}

// Opened from the sidebar's Account row: the plan cards, total cost across
// agents, then Settings. Fixed above the row (`anchor` = its rect)
// and portal'd to <body>; data-popover keeps clicks inside it "inside" for the
// outside-click handler. Mounted only while open, so usage is fetched per open
// (the daemon caches upstream with a 180s floor).
export function AccountMenu({
  anchor, totalCostUsd, pendingMemories = 0, dreamProposals = 0, onReviewDream, onOpenSettings, onOpenMemory, onSetUpProfile,
}) {
  const { accounts } = useAccounts();
  const { profile } = useProfile();
  const [usage, setUsage] = useState(undefined); // undefined = loading, null = none/error

  useEffect(() => { refreshAccounts(); }, []);

  useEffect(() => {
    let alive = true;
    api.getUsage()
      .then((res) => { if (alive) setUsage(res); })
      .catch(() => { if (alive) setUsage(null); });
    return () => { alive = false; };
  }, []);

  const pos = { left: Math.round(anchor.left + 8), bottom: Math.round(window.innerHeight - anchor.top + 6) };

  return createPortal(
    <div className="acct-menu" data-popover="account-menu" role="menu" aria-label="Account" style={pos}>
      <ProfileMenuHeader profile={profile} onOpen={() => onOpenSettings("profile")} onSetUp={onSetUpProfile} />
      {dreamProposals > 0 && <DreamReviewRow count={dreamProposals} onOpen={onReviewDream} />}
      {pendingMemories > 0 && <MemoryReviewRow count={pendingMemories} onOpen={onOpenMemory} />}
      <PlanCards accounts={accounts} usage={usage} />
      <div
        className="acct-total"
        title="Estimated API-equivalent cost across all agents. If you use a Max/Pro subscription, no actual money is charged."
      >
        <span>Total cost · all agents</span>
        <b>{fmtCost(totalCostUsd)}</b>
      </div>
      <div className="acct-sep" />
      <button className="acct-action" role="menuitem" onClick={() => onOpenMemory?.()}>
        <MemoryIcon />Memory
      </button>
      <button className="acct-action" role="menuitem" onClick={() => onOpenSettings()}>
        <GeneralIcon />Settings<span className="acct-kbd">⌘,</span>
      </button>
    </div>,
    document.body,
  );
}
