import { useEffect } from "react";
import { useUi } from "../../../state/ui.jsx";
import { EosSwitcher } from "../../../components/EosSwitcher.jsx";
import { SettingsFooter } from "../../../components/SettingsFooter.jsx";
import { HostChip } from "../../../components/machines/HostChip.jsx";
import { PresenceChip } from "../../../components/machines/PresenceChip.jsx";
import { ensureInboxLoaded } from "../../../state/eos/inboxStore.js";
import { ensureRoutinesLoaded } from "../../../state/eos/routinesStore.js";
import { parseLocation, useEosLocation } from "../nav/eosNav.js";
import { NavRows } from "./NavRows.jsx";
import { RoutineRows } from "./RoutineRows.jsx";

function CollapseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2" y="3" width="12" height="10" rx="2" /><line x1="6" y1="3" x2="6" y2="13" />
    </svg>
  );
}

// Eos's own rows in the sidebar, below the chrome every mode shares. They read
// only Eos's own stores, so the sample gallery draws them as the app does.
export function EosSidebarRows() {
  const location = parseLocation(useEosLocation());
  useEffect(() => {
    ensureRoutinesLoaded();
    ensureInboxLoaded();
  }, []);
  return (
    <>
      <NavRows screen={location?.screen} />
      <RoutineRows selectedId={location?.routineId} />
    </>
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
