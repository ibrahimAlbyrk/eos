import { useEffect } from "react";
import { useUi } from "../../state/ui.jsx";
import { EosSwitcher } from "../../components/EosSwitcher.jsx";
import { SettingsFooter } from "../../components/SettingsFooter.jsx";
import { HostChip } from "../../components/machines/HostChip.jsx";
import { PresenceChip } from "../../components/machines/PresenceChip.jsx";
import { MachineGlyph } from "../../components/machines/MachineGlyph.jsx";
import { GridIcon, PlusIcon } from "../../components/machines/icons.jsx";
import {
  useHosts, ensureHostsLoaded, switchMachine, hostLabel, linkTone, latencyLabel, routeLabel, openConnectSheet, canSwitchMachines,
} from "../../state/hostsStore.js";

function CollapseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2" y="3" width="12" height="10" rx="2" /><line x1="6" y1="3" x2="6" y2="13" />
    </svg>
  );
}

export function MachinesSidebar({ live, variant = "full", needs = 0 }) {
  const ui = useUi();
  const { hosts, local } = useHosts();
  useEffect(() => { ensureHostsLoaded(); }, []);
  const full = variant === "full";

  const body = (
    <>
      {full && (
        <div className="side-top">
          <span className="side-dot" /><span className="side-dot" /><span className="side-dot" />
          <button className="side-collapse" title="Collapse panel" onClick={() => ui.collapseSidebar()}><CollapseIcon /></button>
          <HostChip />
          <PresenceChip />
        </div>
      )}
      <EosSwitcher />
      <div className="sb-nav">
        <button className="sb-nav-row on">
          <span className="sb-nav-row__ic"><GridIcon /></span>
          <span className="sb-nav-row__label">All machines</span>
          {needs > 0 && <span className="sb-nav-row__meta" style={{ color: "var(--warn)" }} title={`${needs} waiting on you`}>{needs}</span>}
        </button>
        <button className="sb-nav-row" onClick={openConnectSheet}><span className="sb-nav-row__ic"><PlusIcon /></span><span className="sb-nav-row__label">Connect a machine</span></button>
      </div>
      <div className="sb-seclabel"><span className="sb-seclabel__text">Machines</span></div>
      <div className="agents-section">
        <button className="agents-row machines-side-row" onClick={() => switchMachine(null)}>
          <MachineGlyph name={local?.name} platform={local?.platform} tone="ok" />
          <span className="ag-name">{local?.name ?? "This Mac"}</span>
          <span className="ag-status">this Mac</span>
        </button>
        {hosts.map((h) => (
          <button
            key={h.id}
            className={"agents-row machines-side-row" + (h.link?.state === "offline" ? " agents-row--archived" : "")}
            disabled={!canSwitchMachines()}
            onClick={() => switchMachine(h.id)}
          >
            <MachineGlyph name={h.name} platform={h.platform} tone={linkTone(h.link)} />
            <span className="ag-name">{hostLabel(h)}</span>
            <span className="ag-status">{latencyLabel(h.link) ?? routeLabel(h.link).toLowerCase()}</span>
          </button>
        ))}
      </div>
      <SettingsFooter live={live} />
    </>
  );

  if (variant === "popup") return body;
  return <div className="side-island side-island--agents">{body}</div>;
}
