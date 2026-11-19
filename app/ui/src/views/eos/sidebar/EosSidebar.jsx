import { useUi } from "../../../state/ui.jsx";
import { EosSwitcher } from "../../../components/EosSwitcher.jsx";
import { SettingsFooter } from "../../../components/SettingsFooter.jsx";
import { HostChip } from "../../../components/machines/HostChip.jsx";
import { PresenceChip } from "../../../components/machines/PresenceChip.jsx";
import { NavRow } from "../../agents/sidebar/NavRow.jsx";
import { openLocation, parseLocation, useEosLocation } from "../nav/eosNav.js";

function CollapseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2" y="3" width="12" height="10" rx="2" /><line x1="6" y1="3" x2="6" y2="13" />
    </svg>
  );
}

function CapabilitiesIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM11 9v4M9 11h4" />
    </svg>
  );
}

// Eos's own rows in the sidebar, below the chrome every mode shares. They read
// only Eos's own stores, so the sample gallery draws them as the app does.
export function EosSidebarRows() {
  const screen = parseLocation(useEosLocation())?.screen;
  const onCapabilities = screen === "capabilities" || screen === "capability";
  return (
    <nav className="sb-nav" aria-label="Eos">
      <NavRow
        icon={<CapabilitiesIcon />}
        label="Capabilities"
        selected={onCapabilities}
        strong={onCapabilities}
        onClick={() => openLocation("eos:/capabilities")}
      />
    </nav>
  );
}

export function EosSidebar({ live, variant = "full" }) {
  const ui = useUi();

  const body = (
    <>
      {variant === "full" && (
        <div className="side-top">
          <span className="side-dot" /><span className="side-dot" /><span className="side-dot" />
          <button className="side-collapse" title="Collapse panel" onClick={() => ui.collapseSidebar()}><CollapseIcon /></button>
          <HostChip />
          <PresenceChip />
        </div>
      )}
      <EosSwitcher />
      <EosSidebarRows />
      <SettingsFooter live={live} />
    </>
  );

  if (variant === "popup") return body;
  return <div className="side-island side-island--agents">{body}</div>;
}
